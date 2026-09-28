import { db } from "@/lib/db"
import { igWarmupJobs, igRunLogs } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { getAccountsForUser } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import { extractMedia, extractNextCursor } from "@/lib/instagram/parse"
import type { WarmupConfig, WarmupKind } from "./types"

// Surface-specific wiring so one scroll loop can drive either the home feed or
// the reels tab. Each surface has its own fetch call, container_module (used by
// like/save/follow), and human-readable labels for the activity log.
type Surface = {
  containerModule: string
  scrollLabel: string
  scrollMessage: string
  watchPhase: string
  scrollPhase: string
  // Surface-specific dwell + pause windows (ms). Feed = quick glances; Reels =
  // longer video watches with occasional instant swipes.
  watchMin: number
  watchMax: number
  batchMin: number
  batchMax: number
  // Probability of skipping a post/reel almost instantly without engaging.
  skipChance: number
}

const SURFACES: Record<"feed_scroll" | "reels_scroll", Surface> = {
  feed_scroll: {
    containerModule: "feed_timeline",
    scrollLabel: "Feed Scroll",
    scrollMessage: "Скроллит ленту Feed",
    watchPhase: "watching feed",
    scrollPhase: "scrolling feed",
    watchMin: 700,
    watchMax: 6_500,
    batchMin: 4_000,
    batchMax: 14_000,
    skipChance: 0.45, // a lot of feed posts get a quick glance and a scroll-by
  },
  reels_scroll: {
    containerModule: "clips_viewer_clips_tab",
    scrollLabel: "Reels Scroll",
    scrollMessage: "Скроллит Reels",
    watchPhase: "watching reels",
    scrollPhase: "scrolling reels",
    watchMin: 1_800,
    watchMax: 24_000,
    batchMin: 2_500,
    batchMax: 9_000,
    skipChance: 0.3, // reels are watched longer, but some get swiped immediately
  },
}

// ---- Pacing configuration ---------------------------------------------------
// A warm-up session imitates a human browsing the home feed: it loads a batch of
// posts, "watches" each one for a couple of seconds, occasionally interacts, and
// pauses before scrolling to the next batch. Accounts run grouped into "lanes"
// (see buildLanes) for the configured number of minutes.
const LANE_CONCURRENCY = 8 // how many lanes (≈ distinct IPs) run at once
const CANCEL_POLL_MS = 2_000 // how often interruptible sleeps check for cancel

// Startup stagger. When a job kicks off many accounts at once we don't want
// their first requests to fire in unison. We spread the initial burst across a
// short window — enough to desync them, but "not too much" so the session still
// starts promptly. Subsequent cycles stay desynced via per-account pacing.
const STAGGER_STEP_MS = 600
const STAGGER_MAX_MS = 8_000

// Human reaction / micro-timing. A real user doesn't tap instantly: the thumb
// has to travel and the brain has to decide, and multiple taps on one post are
// spaced out rather than fired as a burst.
const REACTION_MIN_MS = 450 // delay before the first tap on a post
const REACTION_MAX_MS = 1_700
const ACTION_GAP_MIN_MS = 650 // gap between two interactions on the same post
const ACTION_GAP_MAX_MS = 2_200

// Occasionally the user gets distracted / puts the phone down mid-session.
const LONG_BREAK_CHANCE = 0.06
const LONG_BREAK_MIN_MS = 18_000
const LONG_BREAK_MAX_MS = 70_000

// A job whose updatedAt is older than this is considered dead (process died).
export const WARMUP_JOB_STALE_MS = 5 * 60 * 1000

type Account = Awaited<ReturnType<typeof getAccountsForUser>>[number]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (min: number, max: number) => Math.floor(min + Math.random() * (max - min))
const roll = (pct: number) => Math.random() * 100 < pct

// Low-biased dwell time: most posts get a short look, a few get a long one —
// the natural shape of how people actually skim a feed. `exp > 1` skews toward
// the minimum; the rare high roll produces the occasional long watch.
function humanDwell(min: number, max: number, exp = 2): number {
  return Math.floor(min + Math.pow(Math.random(), exp) * (max - min))
}

// Some feed posts genuinely cannot be liked/saved/followed (likes disabled,
// restricted accounts, certain injected units). Instagram returns HTTP 400 with
// a `*_generic` / "cannot ... this media" message. That is expected, not a
// failure of our request, so we treat it as a soft skip instead of an error.
function isSoftReject(r: { ok: boolean; status: number; data?: unknown }): boolean {
  if (r.ok || r.status !== 400) return false
  const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "")
  return /cannot|_generic|not allowed|restricted/i.test(text)
}

async function updateJob(jobId: number, fields: Partial<typeof igWarmupJobs.$inferInsert>) {
  await db
    .update(igWarmupJobs)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(igWarmupJobs.id, jobId))
}

// Read the live cancel flag so the runner can stop between actions.
async function isCancelled(jobId: number): Promise<boolean> {
  const rows = await db
    .select({ cancel: igWarmupJobs.cancelRequested, status: igWarmupJobs.status })
    .from(igWarmupJobs)
    .where(eq(igWarmupJobs.id, jobId))
    .limit(1)
  const row = rows[0]
  return !row || row.cancel || row.status === "cancelled"
}

// Sleep that wakes early if the job is cancelled. Returns true if cancelled.
async function interruptibleSleep(jobId: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await isCancelled(jobId)) return true
    await sleep(Math.min(CANCEL_POLL_MS, end - Date.now()))
  }
  return false
}

// One log row per scroll / interaction so the dashboard and Activity feed show
// exactly what each account is doing.
async function log(
  userId: number | null,
  accountId: number,
  action: string,
  message: string,
  ok: boolean,
  status: number,
  url = "",
) {
  await db.insert(igRunLogs).values({
    userId: userId ?? null,
    accountId,
    action,
    status: ok ? "ok" : "error",
    requestUrl: url,
    responseCode: status || null,
    message,
  })
}

// Bump the global interaction counter on the job.
async function bumpActions(jobId: number, n: number) {
  const rows = await db.select({ c: igWarmupJobs.actionsCount }).from(igWarmupJobs).where(eq(igWarmupJobs.id, jobId)).limit(1)
  const current = rows[0]?.c ?? 0
  await updateJob(jobId, { actionsCount: current + n })
}

// Run the warm-up loop for a single account until the deadline or cancellation.
async function scrollAccount(
  account: Account,
  jobId: number,
  cfg: WarmupConfig,
  deadline: number,
  kind: WarmupKind,
  startupDelayMs = 0,
) {
  const handle = account.username || account.label || `Account ${account.id}`
  const c = new InstagramClient(account)
  const surface = SURFACES[kind === "reels_scroll" ? "reels_scroll" : "feed_scroll"]
  const mod = surface.containerModule
  // Reels share a stable session id and a running list of "seen" reels.
  const reelsSessionId = `${account.id}_${c.accountRandomHex(16).toUpperCase()}`
  const seenReels: string[] = []
  // Per-account "personality": some users browse fast, some linger. Applied as a
  // multiplier to every dwell/pause so two accounts never move in lockstep.
  const speed = 0.7 + c.accountRandom() * 0.7 // 0.7x (snappy) .. 1.4x (leisurely)
  const pace = (ms: number) => Math.max(300, Math.round(ms * speed))

  // Stagger the very first request so a big batch doesn't start in unison.
  if (startupDelayMs > 0) {
    if (await interruptibleSleep(jobId, startupDelayMs)) return
  }

  // Rotate the proxy so this account starts on a fresh IP. For accounts sharing
  // a rotation URL this runs serially (one lane at a time) so two accounts never
  // sit on the same IP simultaneously.
  if (account.rotationUrl) {
    await updateJob(jobId, { currentLabel: handle, phase: "rotating proxy" })
    try {
      const rot = await c.rotateProxy()
      if (rot.rotated && rot.ok) {
        await log(account.userId, account.id, surface.scrollLabel, "Сменил IP (ротация прокси)", true, rot.status)
      } else if (rot.rotated && !rot.ok) {
        await log(account.userId, account.id, surface.scrollLabel, `Ротация прокси не удалась: ${rot.error ?? ""}`, false, rot.status)
      }
    } catch {
      // ignore — a rotation failure shouldn't block the session
    }
  }

  await updateJob(jobId, { currentLabel: handle, phase: surface.scrollPhase })
  await log(account.userId, account.id, surface.scrollLabel, surface.scrollMessage, true, 0)

  let maxId: string | null = null

  while (Date.now() < deadline) {
    if (await isCancelled(jobId)) break

    // Load a page (cold start first, then pagination).
    let items: ReturnType<typeof extractMedia> = []
    try {
      const res =
        kind === "reels_scroll"
          ? await ep.reelScroll(c, { maxId, sessionId: reelsSessionId, seenReels })
          : await ep.feedTimeline(c, { maxId, reason: maxId ? "pagination" : "cold_start_fetch" })
      if (res.ok) {
        items = extractMedia(res.data)
        maxId = extractNextCursor(res.data)
      } else {
        await log(account.userId, account.id, surface.scrollLabel, `Запрос вернул ошибку HTTP ${res.status}`, false, res.status, res.url)
        maxId = null
      }
    } catch (e) {
      await log(account.userId, account.id, surface.scrollLabel, e instanceof Error ? e.message : "Request failed", false, 0)
    }

    // Walk the batch, "watching" each post/reel and occasionally interacting.
    for (const m of items) {
      if (Date.now() >= deadline) break
      if (await isCancelled(jobId)) break

      // Mark reels as seen so the next page advances the session naturally.
      if (kind === "reels_scroll") {
        seenReels.push(m.id)
        if (seenReels.length > 50) seenReels.shift()
      }

      // Decide up front whether this one even grabs attention. A quick swipe-by
      // means a short look and no interaction at all (most of the feed).
      const quickSkip = Math.random() < surface.skipChance
      const watchMs = quickSkip
        ? pace(jitter(surface.watchMin, Math.min(surface.watchMin + 1_200, surface.watchMax)))
        : pace(humanDwell(surface.watchMin, surface.watchMax))

      // Watch the post/reel.
      if (await interruptibleSleep(jobId, watchMs)) break

      // Injected ads / sponsored posts reject like/save/follow (HTTP 400), so a
      // real user can see them but we never interact — just scroll past. A
      // quick-skip post is glanced at but not engaged with either.
      if (m.isAd || quickSkip) continue

      // Decide the interactions for this post, then perform them the way a human
      // would: a beat of reaction time before the first tap, and a gap between
      // taps. The like usually comes first (double-tap), saves/follow after.
      const doLike = roll(cfg.like)
      const doSave = roll(cfg.save)
      const doRepost = roll(cfg.repost)
      const doFollow = !!m.userId && roll(cfg.follow)

      if (doLike || doSave || doRepost || doFollow) {
        if (await interruptibleSleep(jobId, pace(jitter(REACTION_MIN_MS, REACTION_MAX_MS)))) break
      }

      let acted = false
      const gap = async () => {
        if (acted) await interruptibleSleep(jobId, pace(jitter(ACTION_GAP_MIN_MS, ACTION_GAP_MAX_MS)))
        acted = true
      }

      if (doLike) {
        await gap()
        const r = await ep.likeMedia(c, m.id, { containerModule: mod })
        if (isSoftReject(r)) {
          await log(account.userId, account.id, "Like", "Пропустил (лайк недоступен)", true, r.status, r.url)
        } else {
          await log(account.userId, account.id, "Like", "Отправил лайк", r.ok, r.status, r.url)
          await bumpActions(jobId, 1)
        }
      }
      if (doSave) {
        await gap()
        const r = await ep.saveMedia(c, m.id, { containerModule: mod })
        if (isSoftReject(r)) {
          await log(account.userId, account.id, "Save", "Пропустил (сохранение недоступно)", true, r.status, r.url)
        } else {
          await log(account.userId, account.id, "Save", "Сохранил пост", r.ok, r.status, r.url)
          await bumpActions(jobId, 1)
        }
      }
      if (doRepost) {
        await gap()
        const r = await ep.repost(c, m.id, { containerModule: mod })
        if (isSoftReject(r)) {
          await log(account.userId, account.id, "Repost", "Пропустил (репост недоступен)", true, r.status, r.url)
        } else {
          await log(account.userId, account.id, "Repost", "Сделал репост", r.ok, r.status, r.url)
          await bumpActions(jobId, 1)
        }
      }
      if (doFollow) {
        await gap()
        const r = await ep.follow(c, m.userId!, { mediaId: m.id, containerModule: mod })
        if (isSoftReject(r)) {
          await log(account.userId, account.id, "Follow", `Пропустил @${m.username || m.userId} (подписка недоступна)`, true, r.status, r.url)
        } else {
          await log(account.userId, account.id, "Follow", `Подписался на @${m.username || m.userId}`, r.ok, r.status, r.url)
          await bumpActions(jobId, 1)
        }
      }
    }

    // Pause before scrolling further. Occasionally the user gets distracted and
    // takes a much longer break before coming back to scroll.
    await updateJob(jobId, { currentLabel: handle, phase: surface.watchPhase })
    let pauseMs = pace(jitter(surface.batchMin, surface.batchMax))
    if (Math.random() < LONG_BREAK_CHANCE) {
      pauseMs = jitter(LONG_BREAK_MIN_MS, LONG_BREAK_MAX_MS)
      await log(account.userId, account.id, surface.scrollLabel, "Отвлёкся, пауза в ленте", true, 0)
    }
    if (await interruptibleSleep(jobId, pauseMs)) break
  }
}

// Group accounts into "lanes" by their rotation URL.
//  - Accounts that SHARE a rotation URL are one shared IP: they must run one at a
//    time, rotating the proxy before each, so two never sit on the same IP at
//    once. They go into a single serial lane.
//  - Accounts with an empty rotation URL are independent and can run fully in
//    parallel — each becomes its own single-account lane.
// Lanes themselves run concurrently (capped by LANE_CONCURRENCY), so distinct
// rotation URLs and free accounts all make progress at the same time.
function buildLanes(accounts: Account[]): Account[][] {
  const serial = new Map<string, Account[]>()
  const free: Account[][] = []
  for (const a of accounts) {
    const key = (a.rotationUrl || "").trim()
    if (key) {
      const arr = serial.get(key) ?? []
      arr.push(a)
      serial.set(key, arr)
    } else {
      free.push([a])
    }
  }
  return [...free, ...serial.values()]
}

// Run lanes with a concurrency cap, passing each lane its dispatch index so the
// initial burst can be staggered.
async function runLanes(lanes: Account[][], limit: number, fn: (lane: Account[], laneIndex: number) => Promise<void>) {
  let cursor = 0
  async function worker() {
    while (cursor < lanes.length) {
      const idx = cursor++
      await fn(lanes[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, lanes.length) }, worker))
}

// Detached background processor. Never throws — failures land on the job row.
export async function runWarmupJob(jobId: number) {
  try {
    const rows = await db.select().from(igWarmupJobs).where(eq(igWarmupJobs.id, jobId)).limit(1)
    const job = rows[0]
    if (!job) return

    const cfg = job.config as WarmupConfig
    const kind = job.kind as WarmupKind
    const ids = (job.accountIds as number[]) ?? []
    // Cookie-free: load only the owner's accounts (detached job has no request).
    const all = await getAccountsForUser(job.userId)
    const accounts = ids.length ? all.filter((a) => ids.includes(a.id)) : all

    await updateJob(jobId, { status: "running", total: accounts.length, processed: 0, phase: "starting" })

    if (accounts.length === 0) {
      await updateJob(jobId, { status: "done", phase: "no accounts", finishedAt: new Date() })
      return
    }

    const deadline = Date.now() + Math.max(1, cfg.durationMin) * 60_000
    let processed = 0

    const lanes = buildLanes(accounts)

    // User-chosen parallelism (how many accounts/lanes run at once). Clamp to
    // 1..20 and fall back to the default when unset.
    const laneLimit = Math.min(Math.max(job.concurrency ?? LANE_CONCURRENCY, 1), 20)

    await runLanes(lanes, laneLimit, async (lane, laneIndex) => {
      // Stagger the first start of each concurrently-dispatched lane so their
      // opening requests don't fire at the same instant.
      const baseStagger = Math.min(laneIndex * STAGGER_STEP_MS, STAGGER_MAX_MS)
      let first = true
      for (const account of lane) {
        if (Date.now() >= deadline) break
        if (await isCancelled(jobId)) break
        const startupDelayMs = first ? baseStagger + jitter(0, STAGGER_STEP_MS) : 0
        first = false
        await scrollAccount(account, jobId, cfg, deadline, kind, startupDelayMs)
        processed++
        await updateJob(jobId, { processed })
      }
    })

    const cancelled = await isCancelled(jobId)
    await updateJob(jobId, {
      status: cancelled ? "cancelled" : "done",
      phase: cancelled ? "cancelled" : "done",
      finishedAt: new Date(),
    })
  } catch (e) {
    await updateJob(jobId, { status: "error", error: e instanceof Error ? e.message : "failed", finishedAt: new Date() })
  }
}
