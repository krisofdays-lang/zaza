// Per-proxy-group gate that guarantees a minimum spacing between the START of
// any two publish flows (Post Reel / Media / Story) for accounts that share the
// same outbound IP.
//
// Previously this was a single, process-wide mutex — ALL accounts shared one
// cadence, creating a detectable timing pattern that linked otherwise-isolated
// accounts. Now each proxy group (keyed by rotationUrl) has its own independent
// gate, so:
//   • Accounts on different proxies publish in parallel with no mutual delay.
//   • Accounts on the SAME rotating proxy (= same public IP) are still
//     serialized so two publishes can't collide on one exit node.
//   • Accounts with NO proxy (rotationUrl = "") share one fallback gate,
//     since they all egress from the server's own IP.
//
// This eliminates the "global metronome" signal while preserving the same-IP
// collision avoidance that the original gate provided.

interface GateState {
  chain: Promise<void>
  lastPublishAt: number
}

// Per-group gate map. Empty-string key = no proxy (server IP).
const gates = new Map<string, GateState>()

function getGate(proxyKey: string): GateState {
  let g = gates.get(proxyKey)
  if (!g) {
    g = { chain: Promise.resolve(), lastPublishAt: 0 }
    gates.set(proxyKey, g)
  }
  return g
}

export interface PublishSlot {
  // How long this call actually waited for its slot (ms), for logging.
  waited: number
  // True if the run was cancelled during the wait — caller should bail out.
  cancelled: boolean
}

// Acquire a publish slot for the given proxy group. `proxyKey` is typically the
// account's rotationUrl (empty string for accounts without a rotating proxy).
// `sleep` must be an interruptible sleep that resolves to true if the run was
// cancelled during the wait. The spacing is a fresh uniformly-random value in
// [minMs, maxMs] each time so the cadence is never a fixed, detectable number.
// The `random` callback should use the account's seeded PRNG for isolation.
export function acquirePublishSlot(
  proxyKey: string,
  minMs: number,
  maxMs: number,
  sleep: (ms: number) => Promise<boolean>,
  random?: () => number,
): Promise<PublishSlot> {
  const g = getGate(proxyKey)
  let release!: () => void
  const prev = g.chain
  g.chain = new Promise<void>((res) => {
    release = res
  })
  return (async () => {
    // Wait our turn: only one lane holds the reserve section at a time within
    // this proxy group.
    await prev
    try {
      const rng = random ?? Math.random
      const lo = Math.max(0, Math.round(minMs))
      const hi = Math.max(lo, Math.round(maxMs))
      const spacing = lo + Math.floor(rng() * (hi - lo + 1))
      const wait = Math.max(0, g.lastPublishAt + spacing - Date.now())
      let cancelled = false
      if (wait > 0) cancelled = await sleep(wait)
      // Stamp AFTER waiting so the next publish measures its gap from this
      // one's actual moment, not from when this call happened to enter.
      g.lastPublishAt = Date.now()
      return { waited: wait, cancelled }
    } finally {
      // Always hand the chain to the next waiter, even on cancel/throw, so a
      // single aborted publish can never deadlock the rest of the run.
      release()
    }
  })()
}

// Node action keys that create timestamped, publicly-visible content and must
// therefore be spaced apart by the gate. This covers the whole "Publications"
// category — reels, media, stories AND highlights — so no two publish actions
// on the same proxy can land in the same moment. Profile edits and
// engagement actions (follow/comment/scroll) are excluded: they don't create
// timestamped feed/profile content that carries the clustering signal.
export const PUBLISH_ACTION_KEYS = new Set([
  "post_reel",
  "post_media",
  "post_story",
  "create_highlight",
])
