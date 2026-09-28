// Shared, framework-agnostic helpers for interpreting the workflow graph that
// the editor produces. Used by both the client (use-workflow-run) and the
// server runner so the execution order is defined in exactly one place.

export interface GraphNode {
  id: string
  type?: string
  data?: { actionKey?: string; label?: string; config?: unknown }
}

export interface GraphEdge {
  source: string
  target: string
}

export interface WorkflowGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// A single executable step resolved from the graph.
export interface RunNode {
  id: string
  label: string
  actionKey: string
  config?: unknown
}

// The Start node's configuration, stored on the node with id "start".
export interface StartConfig {
  // Delay (ms) inserted between consecutive steps for every account. Kept for
  // backward compatibility and used as the fixed fallback when no range is set.
  delayMs: number
  // Random delay (ms) between consecutive steps. A uniformly random value in
  // [delayMinMs, delayMaxMs] is picked before each step so the gap between nodes
  // is never a fixed, detectable number. When the range is degenerate
  // (min === max) the delay is effectively fixed.
  delayMinMs: number
  delayMaxMs: number
  // When true, occasionally insert natural-behaviour filler (feed/reels scroll,
  // self-profile view) plus small random jitter between steps. When false the
  // steps run back-to-back separated only by `delayMs`.
  naturalBehavior: boolean
  // How many accounts run in parallel (1 = strictly sequential, up to 20).
  // Governs the whole workflow run, so it lives on the Start node.
  concurrency: number
  // Random pause (ms) inserted AFTER each account finishes, before the next one
  // in the same lane starts. A uniformly random value in
  // [accountPauseMinMs, accountPauseMaxMs] is picked each time so accounts don't
  // start on a fixed cadence (a bot tell). 0/0 disables it. SEQUENTIAL only:
  // this spaces out consecutive accounts within a single lane.
  accountPauseMinMs: number
  accountPauseMaxMs: number
  // Legacy random stagger (ms) between parallel lane starts. Superseded by
  // laneStaggerWindowMs (even distribution over a window). Kept only so old saved
  // graphs still spread their starts: when no window is set we fall back to the
  // old max as the window. Not surfaced in the UI anymore.
  laneStaggerMinMs: number
  laneStaggerMaxMs: number
  // Total window (ms) over which the start of ALL parallel lanes is spread when
  // concurrency > 1. Lanes are distributed EVENLY across this window (each lane
  // gets its own slot = window / laneCount, plus a random in-slot jitter), so
  // starts never collide in the same tiny window (which would cluster their
  // client_timestamp / upload_id / publish_id on the same server ms — a strong
  // coordination signal) AND no lane ever waits longer than the window itself
  // (unlike a cumulative schedule where the last lane waited the SUM of gaps).
  // The user picks this window in the Start node. 0 disables staggering.
  laneStaggerWindowMs: number
  // Global minimum spacing (ms) between the START of any two publish steps
  // (Post Reel / Media / Story) across EVERY lane — enforced by a process-wide
  // gate, NOT by start staggering. A fresh random value in
  // [publishGapMinMs, publishGapMaxMs] is required between consecutive posts, so
  // two accounts can never publish in the same window no matter when their lanes
  // started or how their per-step delays drifted. 0/0 disables it. This is the
  // only setting that GUARANTEES posts don't collide; the stagger window only
  // spreads lane starts statistically.
  publishGapMinMs: number
  publishGapMaxMs: number
}

export const DEFAULT_START_CONFIG: StartConfig = {
  delayMs: 3000,
  delayMinMs: 3000,
  delayMaxMs: 3000,
  naturalBehavior: false,
  concurrency: 1,
  accountPauseMinMs: 0,
  accountPauseMaxMs: 0,
  laneStaggerMinMs: 0,
  laneStaggerMaxMs: 0,
  laneStaggerWindowMs: 0,
  publishGapMinMs: 0,
  publishGapMaxMs: 0,
}

// Read + normalise the Start node config from a graph.
export function getStartConfig(graph: WorkflowGraph): StartConfig {
  const start = graph.nodes.find((n) => n.id === "start" || n.type === "start")
  const cfg = (start?.data?.config ?? {}) as Partial<StartConfig>
  const delayMs = typeof cfg.delayMs === "number" && cfg.delayMs >= 0 ? cfg.delayMs : DEFAULT_START_CONFIG.delayMs
  return {
    delayMs,
    ...normalizeStepDelay(cfg.delayMinMs, cfg.delayMaxMs, delayMs),
    naturalBehavior: Boolean(cfg.naturalBehavior),
    concurrency:
      typeof cfg.concurrency === "number" && cfg.concurrency >= 1
        ? Math.min(Math.round(cfg.concurrency), 20)
        : DEFAULT_START_CONFIG.concurrency,
    ...normalizeAccountPause(cfg.accountPauseMinMs, cfg.accountPauseMaxMs),
    ...normalizeLaneStagger(cfg.laneStaggerMinMs, cfg.laneStaggerMaxMs),
      laneStaggerWindowMs: normalizeStaggerWindow(cfg.laneStaggerWindowMs, cfg.laneStaggerMaxMs),
      ...normalizePublishGap(cfg.publishGapMinMs, cfg.publishGapMaxMs),
    }
  }

  // Validate the global publish-spacing range. Reuses orderedRange so a swapped
  // min/max is corrected and negatives are clamped. 0/0 => gate disabled.
  function normalizePublishGap(
    min: unknown,
    max: unknown,
  ): { publishGapMinMs: number; publishGapMaxMs: number } {
    const [lo, hi] = orderedRange(min, max)
    return { publishGapMinMs: lo, publishGapMaxMs: hi }
  }

// Resolve the parallel-lane stagger WINDOW. Prefer the explicit window; if it's
// absent (old graph that only stored the legacy min/max range) fall back to the
// old max so those workflows keep spreading their parallel starts.
function normalizeStaggerWindow(windowMs: unknown, legacyMaxMs: unknown): number {
  if (typeof windowMs === "number" && windowMs >= 0) return Math.round(windowMs)
  if (typeof legacyMaxMs === "number" && legacyMaxMs > 0) return Math.round(legacyMaxMs)
  return 0
}

// Resolve the between-steps delay range. If an explicit range is provided use
// it (ordered); otherwise fall back to a fixed range equal to `fallbackMs` so
// legacy configs that only stored `delayMs` keep their exact behaviour.
function normalizeStepDelay(
  min: unknown,
  max: unknown,
  fallbackMs: number,
): { delayMinMs: number; delayMaxMs: number } {
  const hasRange = typeof min === "number" || typeof max === "number"
  if (!hasRange) return { delayMinMs: fallbackMs, delayMaxMs: fallbackMs }
  const [lo, hi] = orderedRange(min, max)
  return { delayMinMs: lo, delayMaxMs: hi }
}

// Clamp the between-accounts pause to a sane, ordered [min, max] range.
function normalizeAccountPause(
  min: unknown,
  max: unknown,
): { accountPauseMinMs: number; accountPauseMaxMs: number } {
  const [lo, hi] = orderedRange(min, max)
  return { accountPauseMinMs: lo, accountPauseMaxMs: hi }
}

// Clamp the parallel-lane stagger to a sane, ordered [min, max] range.
function normalizeLaneStagger(
  min: unknown,
  max: unknown,
): { laneStaggerMinMs: number; laneStaggerMaxMs: number } {
  const [lo, hi] = orderedRange(min, max)
  return { laneStaggerMinMs: lo, laneStaggerMaxMs: hi }
}

// If only one bound is set, treat it as a fixed value. Otherwise order them.
function orderedRange(min: unknown, max: unknown): [number, number] {
  const lo = typeof min === "number" && min >= 0 ? Math.round(min) : 0
  const hi = typeof max === "number" && max >= 0 ? Math.round(max) : 0
  return [Math.min(lo, hi), Math.max(lo, hi)]
}

// Order the action nodes by walking the edges out of `start`. Falls back to any
// leftover (disconnected) action nodes in their existing order so nothing is
// silently dropped from a run. This defines the STRICT sequential order.
export function orderActionNodes(graph: WorkflowGraph): RunNode[] {
  const { nodes, edges } = graph
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outgoing = new Map<string, string[]>()
  for (const e of edges) {
    const list = outgoing.get(e.source) ?? []
    list.push(e.target)
    outgoing.set(e.source, list)
  }
  const ordered: RunNode[] = []
  const seen = new Set<string>()
  const queue: string[] = ["start"]
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node && node.type === "action") {
      const d = node.data ?? {}
      ordered.push({ id, label: d.label || "Step", actionKey: d.actionKey || "", config: d.config })
    }
    for (const next of outgoing.get(id) ?? []) queue.push(next)
  }
  for (const n of nodes) {
    if (n.type === "action" && !seen.has(n.id)) {
      const d = n.data ?? {}
      ordered.push({ id: n.id, label: d.label || "Step", actionKey: d.actionKey || "", config: d.config })
    }
  }
  return ordered
}
