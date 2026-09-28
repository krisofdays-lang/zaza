import { db } from "@/lib/db"
import { igAnalyticsJobs, igAnalyticsSnapshots } from "@/lib/db/schema"
import { desc, eq } from "drizzle-orm"
import { getAccountsForUser } from "@/lib/data/accounts"
import { getBusyAccountIds } from "@/lib/data/busy-accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import { extractMedia } from "@/lib/instagram/parse"
import type { AccountAnalytics, AnalyticsReel, AnalyticsResult } from "./types"

// ---- Pacing / safety configuration -----------------------------------------
// Accounts that share an egress IP (same proxy, or all running direct) are
// processed strictly one-at-a-time with a long pause between them, and the proxy
// is rotated before each request. Accounts on DISTINCT proxies run in parallel.
export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000 // a snapshot is "fresh" for 6h
const ROTATE_MAX_ATTEMPTS = 5
const ROTATE_RETRY_MS = 2 * 60 * 1000 // wait 2 min, then retry rotation
const PACE_MIN_MS = 2 * 60 * 1000 // min gap between accounts on the same IP
const PACE_MAX_MS = 3 * 60 * 1000 // max gap between accounts on the same IP
const GROUP_CONCURRENCY = 10 // max distinct proxies hit at once
// A job whose updatedAt is older than this is considered dead (process died) and
// may be superseded by a new refresh.
export const JOB_STALE_MS = 8 * 60 * 1000

// ---- In-use queueing --------------------------------------------------------
// If an account we want to refresh is mid-way through another task (workflow,
// warmup, publication), we don't touch it — we push it to the back of its proxy
// queue and come back later. When it is the LAST account left (nothing else to
// process meanwhile), we instead give it a short window to free up and then
// proceed regardless, so a stuck task can't block the refresh forever.
const BUSY_CACHE_MS = 15 * 1000 // re-check the busy set at most this often
const BUSY_MAX_DEFERRALS = 4 // how many times one account may be sent to the back
const BUSY_DEFER_PAUSE_MS = 30 * 1000 // pause after deferring before moving on
const BUSY_LAST_WAIT_ATTEMPTS = 4 // polls to wait on the final still-busy account
const BUSY_LAST_WAIT_MS = 30 * 1000 // gap between those polls

type Account = Awaited<ReturnType<typeof getAccountsForUser>>[number]
type ProfileShape = { profile_pic_url?: string } | null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (min: number, max: number) => Math.floor(min + Math.random() * (max - min))

// Accounts sharing this key egress from the same IP and must be serialized.
function proxyKey(a: Account): string {
  if (a.proxyType === "none" || !a.proxyUrl.trim()) return "__direct__"
  return `${a.proxyType}|${a.proxyUrl.trim()}`
}

async function updateJob(jobId: number, fields: Partial<typeof igAnalyticsJobs.$inferInsert>) {
  await db
    .update(igAnalyticsJobs)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(igAnalyticsJobs.id, jobId))
}

// Rotate the proxy before a request. Retries every ROTATE_RETRY_MS until success
// or the attempt cap is hit. Accounts without a rotation URL succeed immediately.
async function rotateWithRetry(account: Account, jobId: number, onPhase: (p: string) => Promise<void>): Promise<boolean> {
  for (let attempt = 1; attempt <= ROTATE_MAX_ATTEMPTS; attempt++) {
    await onPhase(attempt === 1 ? "rotating proxy" : `rotating proxy (retry ${attempt - 1})`)
    try {
      // Cookie-free: this runs detached, so call the client directly rather than
      // the request-scoped rotateAccountProxy() action.
      const res = await new InstagramClient(account).rotateProxy()
      if (res.ok) return true
    } catch {
      // fall through to wait + retry
    }
    if (attempt < ROTATE_MAX_ATTEMPTS) {
      await onPhase("rotation failed — waiting 2m")
      await sleep(ROTATE_RETRY_MS)
    }
  }
  return false
}

// Process one account: rotate, then fetch reels and aggregate.
async function processAccount(
  account: Account,
  jobId: number,
  sink: { reels: AnalyticsReel[]; accounts: AccountAnalytics[]; failed: AnalyticsResult["failed"] },
  bump: () => Promise<void>,
) {
  const handle = account.username || account.label || `Account ${account.id}`
  const avatar = ((account.profile as ProfileShape)?.profile_pic_url as string) || ""

  const setPhase = (phase: string) => updateJob(jobId, { currentLabel: handle, phase })

  const rotated = await rotateWithRetry(account, jobId, setPhase)
  if (!rotated) {
    sink.failed.push({ id: account.id, username: account.username, label: account.label })
    sink.accounts.push({ id: account.id, username: handle, label: account.label, avatar, views: 0, likes: 0, comments: 0, reels: 0, engagementRate: 0 })
    await bump()
    return
  }

  await setPhase("fetching reels")
  // Cookie-free reels fetch (detached): use the client directly with the full
  // account row we already loaded for this user.
  let res: { ok: boolean; status: number; items: ReturnType<typeof extractMedia> }
  try {
    const client = new InstagramClient(account)
    const r = await ep.profileReels(client, account.igUserId || client.uid, null)
    res = { ok: r.ok, status: r.status, items: extractMedia(r.data) }
  } catch {
    res = { ok: false, status: 0, items: [] }
  }

  if (!res.ok) sink.failed.push({ id: account.id, username: account.username, label: account.label })

  let views = 0
  let likes = 0
  let comments = 0
  for (const m of res.items) {
    const v = m.viewCount ?? 0
    const l = m.likeCount ?? 0
    const c = m.commentCount ?? 0
    views += v
    likes += l
    comments += c
    sink.reels.push({
      id: m.id,
      code: m.code,
      accountId: account.id,
      username: handle,
      label: account.label,
      thumbnail: m.thumbnail,
      videoUrl: m.videoUrl,
      caption: m.caption,
      views: v,
      likes: l,
      comments: c,
    })
  }
  sink.accounts.push({
    id: account.id,
    username: handle,
    label: account.label,
    avatar,
    views,
    likes,
    comments,
    reels: res.items.length,
    engagementRate: views > 0 ? ((likes + comments) / views) * 100 : 0,
  })
  await bump()
}

// Run a single proxy group strictly sequentially, pausing between accounts.
// Accounts that are busy with another task are deferred to the back of this
// group's queue instead of being refreshed mid-task; the final busy account is
// waited on briefly then processed regardless.
async function processGroup(
  accounts: Account[],
  jobId: number,
  sink: { reels: AnalyticsReel[]; accounts: AccountAnalytics[]; failed: AnalyticsResult["failed"] },
  bump: () => Promise<void>,
  isBusy: (accountId: number) => Promise<boolean>,
) {
  const queue = [...accounts]
  const deferrals = new Map<number, number>()

  while (queue.length > 0) {
    const account = queue.shift() as Account
    const handle = account.username || account.label || `Account ${account.id}`

    if (await isBusy(account.id)) {
      const hasOthers = queue.length > 0
      const timesDeferred = deferrals.get(account.id) ?? 0
      if (hasOthers && timesDeferred < BUSY_MAX_DEFERRALS) {
        // Something else is still queued — come back to this one later.
        deferrals.set(account.id, timesDeferred + 1)
        await updateJob(jobId, { currentLabel: handle, phase: "in use by another task — deferred in queue" })
        queue.push(account)
        await sleep(BUSY_DEFER_PAUSE_MS)
        continue
      }
      // Last one left (or deferred too many times): give it a short window to
      // free up, then proceed no matter what so a stuck task can't block us.
      for (let attempt = 0; attempt < BUSY_LAST_WAIT_ATTEMPTS && (await isBusy(account.id)); attempt++) {
        await updateJob(jobId, { currentLabel: handle, phase: "waiting for account to finish current task" })
        await sleep(BUSY_LAST_WAIT_MS)
      }
    }

    await processAccount(account, jobId, sink, bump)
    if (queue.length > 0) {
      // Pause before the next account that shares this IP.
      await updateJob(jobId, { phase: `waiting before next account on this proxy` })
      await sleep(jitter(PACE_MIN_MS, PACE_MAX_MS))
    }
  }
}

// Simple concurrency cap for running distinct-proxy groups in parallel.
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++
      await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

function aggregate(
  sink: { reels: AnalyticsReel[]; accounts: AccountAnalytics[]; failed: AnalyticsResult["failed"] },
  accountsCount: number,
): AnalyticsResult {
  const views = sink.accounts.reduce((s, a) => s + a.views, 0)
  const likes = sink.accounts.reduce((s, a) => s + a.likes, 0)
  const comments = sink.accounts.reduce((s, a) => s + a.comments, 0)
  const reels = sink.accounts.reduce((s, a) => s + a.reels, 0)
  return {
    totals: {
      views,
      likes,
      comments,
      reels,
      accounts: accountsCount,
      engagementRate: views > 0 ? ((likes + comments) / views) * 100 : 0,
    },
    accounts: [...sink.accounts].sort((a, b) => b.views - a.views),
    topReels: [...sink.reels].sort((a, b) => b.views - a.views).slice(0, 10),
    generatedAt: new Date().toISOString(),
    failed: sink.failed,
  }
}

// When only a subset of accounts is refreshed, merge the fresh numbers into the
// previous full snapshot so the un-refreshed accounts keep their last-known
// stats instead of vanishing. Account-level rows are exact; topReels is rebuilt
// from the fresh subset plus whatever the previous snapshot still carried for
// the other accounts (the snapshot only stores the top reels, so this is a best
// effort for accounts that weren't refreshed this run).
async function mergeIntoPreviousSnapshot(
  userId: number,
  fresh: AnalyticsResult,
  refreshedIds: number[],
): Promise<AnalyticsResult> {
  const rows = await db
    .select()
    .from(igAnalyticsSnapshots)
    .where(eq(igAnalyticsSnapshots.userId, userId))
    .orderBy(desc(igAnalyticsSnapshots.generatedAt))
    .limit(1)
  const prev = rows[0]?.data as AnalyticsResult | undefined
  if (!prev) return fresh

  const refreshed = new Set(refreshedIds)
  const accounts = [...prev.accounts.filter((a) => !refreshed.has(a.id)), ...fresh.accounts]
  const reels = [...prev.topReels.filter((r) => !refreshed.has(r.accountId)), ...fresh.topReels]

  const views = accounts.reduce((s, a) => s + a.views, 0)
  const likes = accounts.reduce((s, a) => s + a.likes, 0)
  const comments = accounts.reduce((s, a) => s + a.comments, 0)
  const reelCount = accounts.reduce((s, a) => s + a.reels, 0)
  const failedIds = new Set(fresh.failed.map((f) => f.id))
  const failed = [...prev.failed.filter((f) => !refreshed.has(f.id) && !failedIds.has(f.id)), ...fresh.failed]

  return {
    totals: {
      views,
      likes,
      comments,
      reels: reelCount,
      accounts: accounts.length,
      engagementRate: views > 0 ? ((likes + comments) / views) * 100 : 0,
    },
    accounts: [...accounts].sort((a, b) => b.views - a.views),
    topReels: [...reels].sort((a, b) => b.views - a.views).slice(0, 10),
    generatedAt: new Date().toISOString(),
    failed,
  }
}

// Detached background processor. Never throws — failures are recorded on the job.
export async function runAnalyticsJob(jobId: number, userId: number, accountIds: number[]) {
  try {
    const all = await getAccountsForUser(userId)
    const accounts = accountIds.length ? all.filter((a) => accountIds.includes(a.id)) : all

    await updateJob(jobId, { total: accounts.length, processed: 0, phase: "starting" })

    // Group by egress IP so shared-IP accounts are serialized.
    const groups = new Map<string, Account[]>()
    for (const a of accounts) {
      const key = proxyKey(a)
      const arr = groups.get(key)
      if (arr) arr.push(a)
      else groups.set(key, [a])
    }

    const sink = { reels: [] as AnalyticsReel[], accounts: [] as AccountAnalytics[], failed: [] as AnalyticsResult["failed"] }
    let processed = 0
    const bump = async () => {
      processed++
      await updateJob(jobId, { processed })
    }

    // Cached "is this account mid-task?" check, shared across all proxy lanes so
    // we don't hammer the DB. Refreshed at most once per BUSY_CACHE_MS.
    let busyCache: { at: number; set: Set<number> } | null = null
    const isBusy = async (accountId: number): Promise<boolean> => {
      if (!busyCache || Date.now() - busyCache.at > BUSY_CACHE_MS) {
        busyCache = { at: Date.now(), set: await getBusyAccountIds(userId) }
      }
      return busyCache.set.has(accountId)
    }

    await mapWithConcurrency(Array.from(groups.values()), GROUP_CONCURRENCY, (group) =>
      processGroup(group, jobId, sink, bump, isBusy),
    )

    // A subset refresh merges into the last full snapshot so the accounts we
    // didn't touch keep their previous numbers.
    const isPartial = accountIds.length > 0 && accountIds.length < all.length
    const aggregated = aggregate(sink, accounts.length)
    const result = isPartial
      ? await mergeIntoPreviousSnapshot(userId, aggregated, accounts.map((a) => a.id))
      : aggregated
    await db.insert(igAnalyticsSnapshots).values({ userId, data: result, accountsCount: result.totals.accounts })
    await updateJob(jobId, { status: "done", phase: "done", finishedAt: new Date() })
  } catch (e) {
    await updateJob(jobId, { status: "error", error: e instanceof Error ? e.message : "failed", finishedAt: new Date() })
  }
}
