import { db } from "@/lib/db"
import { igWorkflows, igRunLogs } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { getAccountsForUser } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import { extractMedia, extractNextCursor } from "@/lib/instagram/parse"
import {
  orderActionNodes,
  getStartConfig,
  type WorkflowGraph,
  type RunNode,
  type StartConfig,
} from "@/lib/workflows/graph"

// Per-account step runners — each performs the real captured request flow.
import { runBioChangeForAccount } from "@/lib/workflows/bio-runner"
import { runNameChangeForAccount } from "@/lib/workflows/name-runner"
import { runLinkInBioForAccount } from "@/lib/workflows/link-in-bio-runner"
import { runUsernameChangeForAccount } from "@/lib/workflows/username-runner"
import { runProfilePictureForAccount } from "@/lib/workflows/pfp-runner"
import { runRemoveBioLinksForAccount } from "@/lib/workflows/remove-bio-links-runner"
import { runAccountPrivacyForAccount } from "@/lib/workflows/privacy-runner"
import { runPostMediaForAccount } from "@/lib/workflows/post-media-runner"
import { runPostStoryForAccount, runCreateHighlightForAccount } from "@/lib/workflows/story-runner"
import { runFollowTargetsForAccount } from "@/lib/workflows/follow-runner"
import { seedFollowClaims, clearFollowClaims } from "@/lib/workflows/follow-claims"
import type { FollowTargetsConfig } from "@/lib/workflows/types"
import { acquirePublishSlot, PUBLISH_ACTION_KEYS } from "@/lib/workflows/publish-gate"
import { DEFAULT_WARMUP_CONFIG, type WarmupConfig } from "@/lib/warmup/types"

// ---- Pacing / safety constants --------------------------------------------
const CANCEL_POLL_MS = 5_000
// Cooldown enforced between two accounts that share the SAME rotating proxy:
// after one account finishes all its nodes, wait before rotating + starting the
// next account on that proxy. This is the anti-ban delay the user requested.
const PROXY_COOLDOWN_MS = 90_000
// A running job whose updatedAt is older than this is considered dead.
// 15 minutes is generous enough to handle slow proxies, large media
// uploads, and long natural-behaviour pauses without false positives.
export const WORKFLOW_JOB_STALE_MS = 15 * 60 * 1000

type Account = Awaited<ReturnType<typeof getAccountsForUser>>[number]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (min: number, max: number) => Math.floor(min + Math.random() * (max - min))
const roll = (pct: number) => Math.random() * 100 < pct

async function updateWorkflow(id: number, fields: Partial<typeof igWorkflows.$inferInsert>) {
  await db
    .update(igWorkflows)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(igWorkflows.id, id))
}

// Live cancel flag — lets the runner stop between nodes / during sleeps.
async function isCancelled(id: number): Promise<boolean> {
  const rows = await db
    .select({ cancel: igWorkflows.cancelRequested, status: igWorkflows.status })
    .from(igWorkflows)
    .where(eq(igWorkflows.id, id))
    .limit(1)
  const row = rows[0]
  return !row || row.cancel || row.status === "cancelled"
}

// Sleep that wakes early if the job is cancelled. Returns true if cancelled.
async function interruptibleSleep(id: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await isCancelled(id)) return true
    await sleep(Math.min(CANCEL_POLL_MS, Math.max(0, end - Date.now())))
  }
  return false
}

async function log(
  userId: number | null,
  accountId: number | null,
  action: string,
  message: string,
  ok: boolean,
  status = 0,
  url = "",
) {
  await db.insert(igRunLogs).values({
    userId: userId ?? null,
    accountId: accountId ?? null,
    action,
    status: ok ? "ok" : "error",
    requestUrl: url,
    responseCode: status || null,
    message,
  })
}

// Atomically bump a couple of counters on the workflow row using a
// single UPDATE with jsonb_set so parallel lanes don't clobber each other.
async function bumpNodeDone(id: number, nodeId: string) {
  const escapedNodeId = nodeId.replace(/'/g, "''")
  await db.execute(
    `UPDATE ig_workflows
     SET progress = jsonb_set(
           COALESCE(progress, '{}'::jsonb),
           '{${escapedNodeId},done}',
           (COALESCE((progress->'${escapedNodeId}'->>'done')::int, 0) + 1)::text::jsonb
         ),
         actions_count = COALESCE(actions_count, 0) + 1,
         updated_at = NOW()
     WHERE id = ${id}`,
  )
}

// A negative, workflow-scoped claim id so a workflow's Follow pool never
// collides with a warmup job's (warmup uses positive serial ids).
function claimJobId(workflowId: number, nodeIndex: number): number {
  return -(workflowId * 1000 + nodeIndex + 1)
}

// ---- Natural-behaviour filler ----------------------------------------------
// When the Start node's "Natural behavior" toggle is on, between steps the
// account sometimes browses for a few seconds the way a real user would —
// scrolling the feed or reels, or glancing at their own profile — with small
// random timeouts. Best-effort: failures never abort the workflow.
async function naturalInterlude(id: number, account: Account, client: InstagramClient) {
  const pick = Math.random()
  try {
    if (pick < 0.4) {
      await updateWorkflow(id, { currentLabel: handleOf(account), phase: "scrolling feed" })
      const res = await ep.feedTimeline(client, { reason: "cold_start_fetch" })
      const n = res.ok ? extractMedia(res.data).length : 0
      await log(account.userId, account.id, "Feed", `Полистал ленту (${n} постов)`, res.ok, res.status, res.url)
    } else if (pick < 0.8) {
      await updateWorkflow(id, { currentLabel: handleOf(account), phase: "watching reels" })
      const sessionId = `${account.id}_${client.accountRandomHex(16).toUpperCase()}`
      const res = await ep.reelScroll(client, { sessionId })
      const n = res.ok ? extractMedia(res.data).length : 0
      await log(account.userId, account.id, "Reels", `Посмотрел Reels (${n})`, res.ok, res.status, res.url)
    } else {
      await updateWorkflow(id, { currentLabel: handleOf(account), phase: "checking profile" })
      const res = await ep.getCurrentUser(client)
      await log(account.userId, account.id, "Profile", "Заглянул в свой профиль", res.ok, res.status, res.url)
    }
  } catch {
    // ignore — filler is decorative
  }
  // Small human pause after browsing.
  await interruptibleSleep(id, jitter(1_500, 5_000))
}

// Surface-specific dwell / pause windows (ms) for the dedicated scrolling
// nodes. Mirrors the warm-up runner so a node browses like a real session for
// the WHOLE configured duration instead of just loading a page or two.
const SCROLL_SURFACE = {
  feed: { watchMin: 700, watchMax: 6_500, batchMin: 4_000, batchMax: 14_000, skipChance: 0.45, mod: "feed_timeline" },
  reels: { watchMin: 1_800, watchMax: 24_000, batchMin: 2_500, batchMax: 9_000, skipChance: 0.3, mod: "clips_viewer_clips_tab" },
} as const

// Low-biased dwell: most posts get a quick glance, a few get a long look.
function humanDwell(min: number, max: number, exp = 2): number {
  return Math.floor(min + Math.pow(Math.random(), exp) * (max - min))
}

// Hard watchdog around a network call. With proxy agents, axios' own timeout can
// fail to fire while a socket hangs during connect, which would freeze the whole
// account forever. This guarantees the call rejects after `ms` no matter what.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout (соединение зависло)")), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

// A scroll page request that can hang (proxy connect) is capped at 45s.
const SCROLL_REQUEST_TIMEOUT_MS = 45_000
// Give up the scroll session after this many back-to-back network failures.
const SCROLL_MAX_CONSECUTIVE_FAILS = 5

// A scroll session for the dedicated scrolling nodes (Feed/Reels Scrolling,
// Feed Training, Story Tray). It scrolls for the node's configured duration
// (cfg.durationMin), "watching" each post/reel with a human-like dwell and
// occasionally engaging (like/save/repost/follow) at the configured chances.
// When the stream runs out it restarts from the top so the account keeps
// scrolling until the deadline — it no longer finishes after a handful of posts.
async function shortScroll(
  id: number,
  account: Account,
  client: InstagramClient,
  surface: "feed" | "reels",
  cfg: WarmupConfig,
) {
  const s = SCROLL_SURFACE[surface]
  const label = surface === "reels" ? "Reels Scroll" : "Feed Scroll"
  const durationMin = Math.max(1, cfg.durationMin || DEFAULT_WARMUP_CONFIG.durationMin)
  const deadline = Date.now() + durationMin * 60_000
  const sessionId = `${account.id}_${client.accountRandomHex(16).toUpperCase()}`
  const seen: string[] = []
  let maxId: string | null = null
  let viewed = 0
  let fails = 0

  while (Date.now() < deadline) {
    if (await isCancelled(id)) return

    // Load a page (cold start first, then pagination), capped by a hard
    // watchdog so a hung proxy socket can't freeze the account indefinitely.
    let items: ReturnType<typeof extractMedia> = []
    try {
      const res = await withTimeout(
        surface === "reels"
          ? ep.reelScroll(client, { maxId, sessionId, seenReels: seen })
          : ep.feedTimeline(client, { maxId, reason: maxId ? "pagination" : "cold_start_fetch" }),
        SCROLL_REQUEST_TIMEOUT_MS,
      )
      if (res.ok) {
        fails = 0
        items = extractMedia(res.data)
        maxId = extractNextCursor(res.data)
      } else {
        // Non-2xx: log, restart from the top, keep scrolling until the deadline.
        await log(account.userId, account.id, label, `Ошибка HTTP ${res.status}`, false, res.status, res.url)
        maxId = null
        if (await interruptibleSleep(id, jitter(s.batchMin, s.batchMax))) return
        continue
      }
    } catch (e) {
      // Transient network error (socket hang up / timeout). Don't end the whole
      // session on a single blip — log, back off, rotate the proxy, and retry
      // until the deadline. Bail only after several consecutive failures.
      fails++
      await log(
        account.userId,
        account.id,
        label,
        `${e instanceof Error ? e.message : "request failed"} (попытка ${fails}/${SCROLL_MAX_CONSECUTIVE_FAILS})`,
        false,
      )
      if (fails >= SCROLL_MAX_CONSECUTIVE_FAILS) {
        await log(account.userId, account.id, label, "Слишком много сетевых ошибок — сессия прервана", false)
        return
      }
      if (account.rotationUrl) {
        await client.rotateProxy().catch(() => {})
      }
      maxId = null
      if (await interruptibleSleep(id, jitter(s.batchMin, s.batchMax))) return
      continue
    }

    // Stream exhausted — restart from the top so scrolling continues.
    if (items.length === 0) {
      maxId = null
      if (await interruptibleSleep(id, jitter(s.batchMin, s.batchMax))) return
      continue
    }

    // Walk the batch, watching each item and occasionally engaging.
    for (const m of items) {
      if (Date.now() >= deadline) break
      if (await isCancelled(id)) return

      if (surface === "reels") {
        seen.push(m.id)
        if (seen.length > 50) seen.shift()
      }

      const quickSkip = Math.random() < s.skipChance
      const watchMs = quickSkip
        ? jitter(s.watchMin, Math.min(s.watchMin + 1_200, s.watchMax))
        : humanDwell(s.watchMin, s.watchMax)
      if (await interruptibleSleep(id, watchMs)) return
      viewed++

      // Ads / quick-skips are seen but never engaged with.
      if (m.isAd || quickSkip) continue

      if (roll(cfg.like)) {
        const r = await ep.likeMedia(client, m.id, { containerModule: s.mod })
        await log(account.userId, account.id, "Like", r.ok ? "Отправил лайк" : `Лайк не прошёл (HTTP ${r.status})`, r.ok, r.status, r.url)
      }
      if (roll(cfg.save)) {
        const r = await ep.saveMedia(client, m.id, { containerModule: s.mod })
        await log(account.userId, account.id, "Save", r.ok ? "Сохранил пост" : `Сохранение не прошло (HTTP ${r.status})`, r.ok, r.status, r.url)
      }
      if (roll(cfg.repost)) {
        const r = await ep.repost(client, m.id, { containerModule: s.mod })
        await log(account.userId, account.id, "Repost", r.ok ? "Сделал репост" : `Репост не прошёл (HTTP ${r.status})`, r.ok, r.status, r.url)
      }
      if (m.userId && roll(cfg.follow)) {
        const r = await ep.follow(client, m.userId, { mediaId: m.id, containerModule: s.mod })
        await log(account.userId, account.id, "Follow", r.ok ? `Подписался на @${m.username || m.userId}` : `Подписка не прошла (HTTP ${r.status})`, r.ok, r.status, r.url)
      }
    }

    // Pause before scrolling to the next batch.
    if (await interruptibleSleep(id, jitter(s.batchMin, s.batchMax))) return
  }

  await log(account.userId, account.id, label, `Просмотрел ${viewed} за сессию (${durationMin} мин)`, true, 0)
}

function handleOf(a: Account): string {
  return a.username || a.label || `Account ${a.id}`
}

// ---- Node dispatch ----------------------------------------------------------
type Outcome = {
  status: "done" | "skipped" | "failed" | "unchanged"
  reason?: string
  // On failure, the exact IG endpoint that failed and its HTTP code, so the node
  // outcome log line can show WHICH request errored (and its URL) in Live Logs.
  endpoint?: string
  responseStatus?: number
}

async function dispatchNode(
  id: number,
  node: RunNode,
  nodeIndex: number,
  account: Account,
  client: InstagramClient,
): Promise<Outcome> {
  const cfg = (node.config ?? {}) as never
  switch (node.actionKey) {
    case "bio_change":
      return runBioChangeForAccount({ accountId: account.id, config: cfg })
    case "name_change":
      return runNameChangeForAccount({ accountId: account.id, config: cfg })
    case "link_in_bio":
      return runLinkInBioForAccount({ accountId: account.id, config: cfg })
    case "username_change":
      return runUsernameChangeForAccount({ accountId: account.id, config: cfg })
    case "profile_picture":
      return runProfilePictureForAccount({ accountId: account.id, config: cfg })
    case "remove_bio_links":
      return runRemoveBioLinksForAccount({ accountId: account.id })
    case "account_privacy":
      return runAccountPrivacyForAccount({ accountId: account.id, config: cfg })
    case "post_media":
    case "post_reel":
      return runPostMediaForAccount({ account, config: cfg })
      case "post_story":
        return runPostStoryForAccount({
          account,
          config: cfg,
          log: (e) => log(account.userId, account.id, e.action, e.message, e.ok, e.status ?? 0, e.url ?? ""),
        })
      case "create_highlight":
        return runCreateHighlightForAccount({
          account,
          config: cfg,
          log: (e) => log(account.userId, account.id, e.action, e.message, e.ok, e.status ?? 0, e.url ?? ""),
        })
    case "follow_targets":
    case "unfollow_targets": {
      const res = await runFollowTargetsForAccount({
        accountId: account.id,
        jobId: claimJobId(id, nodeIndex),
        mode: node.actionKey === "unfollow_targets" ? "unfollow" : "follow",
        config: cfg as FollowTargetsConfig,
        shouldStop: () => false, // cancellation handled at the node boundary
      })
      if (res.attempted === 0) return { status: "skipped", reason: "no_targets" }
      return { status: res.succeeded > 0 ? "done" : "failed", reason: `${res.succeeded}/${res.attempted}` }
    }
    case "feed_scrolling":
    case "feed_training":
    case "story_tray": {
      const scrollCfg = { ...DEFAULT_WARMUP_CONFIG, ...((node.config ?? {}) as Partial<WarmupConfig>) }
      await shortScroll(id, account, client, "feed", scrollCfg)
      return { status: "done" }
    }
    case "reels_scrolling": {
      const scrollCfg = { ...DEFAULT_WARMUP_CONFIG, ...((node.config ?? {}) as Partial<WarmupConfig>) }
      await shortScroll(id, account, client, "reels", scrollCfg)
      return { status: "done" }
    }
    case "comment_posts":
      return { status: "skipped", reason: "not_implemented" }
    default:
      return { status: "skipped", reason: "unknown_action" }
  }
}

// Stop an individual account once it hits this many failed nodes back-to-back.
// A single failure (or scattered failures) never stops the account — only a run
// of consecutive errors does, which usually means the account/proxy is dead.
const ACCOUNT_MAX_CONSECUTIVE_FAILS = 3

// Run every node, strictly in order, for ONE account.
async function runAccountChain(id: number, account: Account, order: RunNode[], start: StartConfig) {
  const handle = handleOf(account)
  const client = new InstagramClient(account)
  let consecutiveFails = 0

  for (let i = 0; i < order.length; i++) {
    if (await isCancelled(id)) return
    const node = order[i]

    // Per-proxy-group publish spacing: before ANY publish step (Post Reel /
    // Media / Story) take a slot scoped to this account's proxy group so no two
    // posts sharing the same exit IP go out within the configured gap. Accounts
    // on different proxies publish independently — no global serialization that
    // would create a detectable cross-account cadence.
    if (start.publishGapMaxMs > 0 && PUBLISH_ACTION_KEYS.has(node.actionKey)) {
      const proxyKey = (account.rotationUrl || "").trim()
      await updateWorkflow(id, { currentNodeId: node.id, currentLabel: handle, phase: "ожидание слота публикации" })
      const slot = await acquirePublishSlot(
        proxyKey,
        start.publishGapMinMs,
        start.publishGapMaxMs,
        (ms) => interruptibleSleep(id, ms),
        () => client.accountRandom(),
      )
      if (slot.cancelled) return
      if (slot.waited > 0) {
        await log(
          account.userId,
          account.id,
          node.label,
          `Публикация отложена на ${Math.round(slot.waited / 1000)} сек (интервал между постами на прокси)`,
          true,
        )
      }
    }

    await updateWorkflow(id, { currentNodeId: node.id, currentLabel: handle, phase: node.label })
    await log(account.userId, account.id, node.label, `${node.label} — старт`, true)

    let outcome: Outcome
    try {
      outcome = await dispatchNode(id, node, i, account, client)
    } catch (e) {
      outcome = { status: "failed", reason: e instanceof Error ? e.message : "error" }
    }

    const ok = outcome.status === "done" || outcome.status === "unchanged"
    const skipped = outcome.status === "skipped"
    await log(
      account.userId,
      account.id,
      node.label,
      `${node.label} — ${ok ? "готово" : skipped ? `пропущено (${outcome.reason ?? ""})` : `ошибка (${outcome.reason ?? ""})`}`,
      ok || skipped,
      outcome.responseStatus ?? 0,
      outcome.endpoint ?? "",
    )
    await bumpNodeDone(id, node.id)

    // Track consecutive failures; a success/skip resets the streak. After 3 in a
    // row, stop THIS account (not the workflow) — the rest of its nodes are
    // marked done so progress completes, and the run moves to the next account.
    if (outcome.status === "failed") {
      consecutiveFails++
      if (consecutiveFails >= ACCOUNT_MAX_CONSECUTIVE_FAILS) {
        await log(
          account.userId,
          account.id,
          handle,
          `Аккаунт остановлен: ${ACCOUNT_MAX_CONSECUTIVE_FAILS} ошибки подряд`,
          false,
        )
        // Keep node progress consistent for the remaining (skipped) nodes.
        for (let j = i + 1; j < order.length; j++) await bumpNodeDone(id, order[j].id)
        return
      }
    } else {
      consecutiveFails = 0
    }

    // Pace before the next node: random delay in [delayMinMs, delayMaxMs] +
    // optional natural behaviour. A fresh value is picked each step so the gap
    // between nodes is never a fixed, detectable number.
    if (i < order.length - 1) {
      const stepDelay =
        start.delayMaxMs > start.delayMinMs ? jitter(start.delayMinMs, start.delayMaxMs) : start.delayMinMs
      if (await interruptibleSleep(id, stepDelay)) return
      if (start.naturalBehavior && roll(55)) {
        await naturalInterlude(id, account, client)
      }
    }
  }
}

// Group accounts into proxy lanes (same rule as warm-up): accounts sharing a
// rotation URL form one serial lane (rotate → run → cooldown between accounts);
// accounts with no rotation URL each get their own parallel lane.
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

async function runLanes(lanes: Account[][], limit: number, fn: (lane: Account[], laneIndex: number) => Promise<void>) {
  let cursor = 0
  async function worker() {
    while (cursor < lanes.length) {
      const idx = cursor++
      // A lane must never reject the shared Promise.all: if it did, the job's
      // top-level catch would flip the status to "error" and "finish" while the
      // other lanes kept running detached in the background. Swallow here so the
      // job only completes once EVERY lane is truly done.
      try {
        await fn(lanes[idx], idx)
      } catch {
        // lane-level failures are already logged per-account; keep going
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, lanes.length) }, worker))
}

// Detached background processor. Never throws — failures land on the row.
export async function runWorkflowJob(workflowId: number) {
  // Heartbeat handle: while the job is genuinely alive we keep updatedAt fresh
  // so the stale-reconciler can't false-flag a long-running node as
  // "Stopped unexpectedly". Declared out here so `finally` can always clear it.
  let heartbeat: ReturnType<typeof setInterval> | null = null
  try {
    const rows = await db.select().from(igWorkflows).where(eq(igWorkflows.id, workflowId)).limit(1)
    const wf = rows[0]
    if (!wf) return

    const graph = (wf.graph as WorkflowGraph) ?? { nodes: [], edges: [] }
    const order = orderActionNodes(graph)
    const start = getStartConfig(graph)
    const ids = (wf.accountIds as number[]) ?? []
    // Load only the owner's accounts so a workflow can never touch another
    // license's accounts, even if stale ids were persisted in the graph.
    const all = await getAccountsForUser(wf.userId)
    const accounts = ids.length ? all.filter((a) => ids.includes(a.id)) : all

    // Seed progress (each account passes through every node once).
    const progress: Record<string, { done: number; total: number }> = {}
    for (const n of order) progress[n.id] = { done: 0, total: accounts.length }

    await updateWorkflow(workflowId, {
      status: "running",
      total: accounts.length,
      processed: 0,
      actionsCount: 0,
      progress,
      error: "",
      phase: "starting",
      currentNodeId: order[0]?.id ?? "",
      startedAt: new Date(),
      finishedAt: null,
    })

    // Touch updatedAt every 60s independent of node progress. A single node
    // (e.g. Feed Scrolling with natural pauses, or a slow proxy) can easily run
    // longer than WORKFLOW_JOB_STALE_MS between two updateWorkflow() calls; this
    // keeps the row "alive" so reconcileStale only fires when the process is
    // truly dead (in which case this interval is gone too).
    heartbeat = setInterval(() => {
      void db
        .update(igWorkflows)
        .set({ updatedAt: new Date() })
        .where(eq(igWorkflows.id, workflowId))
        .catch((err) => {
          console.error(`[workflow ${workflowId}] heartbeat failed:`, err)
        })
    }, 30_000)

    if (order.length === 0 || accounts.length === 0) {
      await updateWorkflow(workflowId, {
        status: "done",
        phase: order.length === 0 ? "no steps" : "no accounts",
        finishedAt: new Date(),
      })
      return
    }

    // Pre-seed the shared Follow/Unfollow pools for every such node so accounts
    // divide the username list instead of repeating it.
    for (let i = 0; i < order.length; i++) {
      const node = order[i]
      if (node.actionKey === "follow_targets" || node.actionKey === "unfollow_targets") {
        const cfg = (node.config ?? {}) as FollowTargetsConfig
        const jid = claimJobId(workflowId, i)
        await clearFollowClaims(jid)
        await seedFollowClaims(jid, cfg.usernames ?? [])
      }
    }

    const lanes = buildLanes(accounts)
    let processed = 0

    // User-chosen parallelism lives on the Start node (start.concurrency). Clamp
    // to 1..20; it's already normalised by getStartConfig but guard anyway.
    const laneLimit = Math.min(Math.max(start.concurrency || 1, 1), 20)

    // Stagger the START of parallel lanes so accounts don't all begin at t=0.
    // Without this, `laneLimit` lanes launch simultaneously via Promise.all and
    // every account posts inside the same tiny window — a strong coordination
    // signal (same-second client_timestamp / upload_id / publish_id across
    // "unrelated" accounts, since those are all derived from Date.now()).
    //
    // Model: EVEN DISTRIBUTION over a user-chosen window. Each lane owns a slot
    // of size `window / laneCount` and starts at `slot * index + jitter`, where
    // the jitter stays inside the first 60% of its own slot. That guarantees a
    // minimum gap of ~40% of a slot between any two consecutive starts (so they
    // never collide) while capping the wait: the last lane starts at ~window,
    // never at the SUM of gaps (the old cumulative schedule pushed the last lane
    // out to ~20 min for a big batch). Offsets are measured against a shared
    // run-start reference so lanes that queue behind the worker pool don't drift.
    // No-ops for sequential runs (single lane) or when the window is 0.
    const totalLanes = lanes.length
    const staggerParallel = laneLimit > 1 && totalLanes > 1 && start.laneStaggerWindowMs > 0
    const slotMs = staggerParallel ? start.laneStaggerWindowMs / totalLanes : 0
    const runStartMs = Date.now()
    const laneStartGate = async (lane: Account[], laneIndex: number): Promise<boolean> => {
      if (!staggerParallel) return false
      // Target offset from run start: this lane's slot + a random point inside
      // the first 60% of that slot (keeps a guaranteed gap to the next slot).
      const target = slotMs * laneIndex + Math.random() * slotMs * 0.6
      const wait = Math.round(target - (Date.now() - runStartMs))
      if (wait <= 0) return false
      const first = lane[0]
      const handle = handleOf(first)
      await updateWorkflow(workflowId, { currentLabel: handle, phase: `staggered start +${Math.round(wait / 1000)}s` })
      await log(
        first.userId,
        first.id,
        "Workflow",
        `Отложенный старт: пауза ${Math.round(wait / 1000)} сек перед запуском (разнос параллельных аккаунтов)`,
        true,
      )
      return await interruptibleSleep(workflowId, wait)
    }

    await runLanes(lanes, laneLimit, async (lane, laneIndex) => {
      // Space out parallel lane starts. Returns true only if the run was
      // cancelled during the wait, in which case skip the lane entirely.
      if (await laneStartGate(lane, laneIndex)) return
      for (let i = 0; i < lane.length; i++) {
        if (await isCancelled(workflowId)) break
        const account = lane[i]
        const handle = handleOf(account)

        // Isolate each account: an unexpected throw here must not abort the lane
        // (or, via Promise.all, the whole workflow). Worst case we log it and
        // move on to the next account.
        try {
          // Rotate the proxy before the account runs. Only proceed if it worked.
          if (account.rotationUrl) {
            await updateWorkflow(workflowId, { currentLabel: handle, phase: "rotating proxy" })
            try {
              const rot = await new InstagramClient(account).rotateProxy()
              if (rot.rotated && !rot.ok) {
                await log(account.userId, account.id, "Proxy", `Ротация прокси не удалась: ${rot.error ?? ""}`, false, rot.status)
                processed++
                await updateWorkflow(workflowId, { processed })
                continue // skip this account — rotation must succeed first
              }
              if (rot.rotated) await log(account.userId, account.id, "Proxy", "Сменил IP (ротация прокси)", true, rot.status)
            } catch (e) {
              await log(account.userId, account.id, "Proxy", e instanceof Error ? e.message : "rotation failed", false)
              processed++
              await updateWorkflow(workflowId, { processed })
              continue
            }
          }

          await runAccountChain(workflowId, account, order, start)
        } catch (e) {
          await log(account.userId, account.id, handle, `Аккаунт пропущен из-за ошибки: ${e instanceof Error ? e.message : "error"}`, false)
        }
        processed++
        await updateWorkflow(workflowId, { processed })

        // Cooldown before the next account that shares this rotating proxy.
        const sharesProxy = (account.rotationUrl || "").trim().length > 0 && i < lane.length - 1
        if (sharesProxy && !(await isCancelled(workflowId))) {
          const next = handleOf(lane[i + 1])
          await updateWorkflow(workflowId, { currentLabel: next, phase: "cooldown (1.5 min)" })
          await log(account.userId, account.id, "Proxy", "Пауза 1.5 мин перед следующим аккаунтом на этом прокси", true)
          if (await interruptibleSleep(workflowId, PROXY_COOLDOWN_MS)) break
        }

        // User-configured random pause between accounts (Start node). Picked
        // fresh each time so accounts don't start on a fixed cadence, which is a
        // detectable bot pattern. Applies to every lane with more accounts left.
        if (start.accountPauseMaxMs > 0 && i < lane.length - 1 && !(await isCancelled(workflowId))) {
          const pauseMs = jitter(start.accountPauseMinMs, start.accountPauseMaxMs + 1)
          const next = handleOf(lane[i + 1])
          await updateWorkflow(workflowId, { currentLabel: next, phase: `pause ${Math.round(pauseMs / 1000)}s` })
          await log(account.userId, account.id, "Workflow", `Пауза ${Math.round(pauseMs / 1000)} сек перед следующим аккаунтом`, true)
          if (await interruptibleSleep(workflowId, pauseMs)) break
        }
      }
    })

    // Clean up Follow pools.
    for (let i = 0; i < order.length; i++) {
      const node = order[i]
      if (node.actionKey === "follow_targets" || node.actionKey === "unfollow_targets") {
        await clearFollowClaims(claimJobId(workflowId, i))
      }
    }

    const cancelled = await isCancelled(workflowId)
    await updateWorkflow(
      workflowId,
      cancelled
        ? {
            // Stopped by the user: clear progress/counters so a re-entry starts
            // clean, matching the reset stopWorkflow() already applied.
            status: "cancelled",
            phase: "stopped",
            currentNodeId: "",
            currentLabel: "",
            processed: 0,
            actionsCount: 0,
            progress: {},
            finishedAt: new Date(),
          }
        : {
            status: "done",
            phase: "done",
            currentNodeId: "",
            finishedAt: new Date(),
          },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed"
    const stack = e instanceof Error ? e.stack : ""
    console.error(`[workflow ${workflowId}] runner crashed:`, msg, stack)
    await updateWorkflow(workflowId, {
      status: "error",
      error: msg,
      finishedAt: new Date(),
    })
    // Also write a log entry so the crash reason is visible in Live Logs.
    try {
      await log(null, null, "Workflow", `Workflow error: ${msg}`, false)
    } catch { /* best effort */ }
  } finally {
    if (heartbeat) clearInterval(heartbeat)
  }
}
