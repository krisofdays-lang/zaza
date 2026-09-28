import * as ep from "@/lib/instagram/endpoints"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// configure_to_clips returns HTTP 200 for several distinct outcomes and we must
// tell them apart:
//   1. Genuinely published    -> status "ok", or posts[].status "COMPLETED".
//   2. Accepted, finishing     -> posts[].status "PENDING"/"IN_PROGRESS" with
//      async (very common)         error_info.error_type "NO_ERROR" and a media
//                                  id. The reel IS accepted; IG just transcodes
//                                  it server-side. This is NOT a failure.
//   3. Still transcoding       -> body says "processing"/no posts yet. Retry.
//   4. Real failure            -> status "fail", or error_info.error_type set
//                                  to anything other than "NO_ERROR".
// Treating case 2 as "not done" is why two Post Reel nodes back-to-back failed:
// the queued reel comes back PENDING+NO_ERROR (accepted) but never flips to
// COMPLETED inside the retry budget, so it was falsely reported as an error.
type ConfigurePost = {
  status?: string
  media_ids?: Array<number | string>
  error_info?: { error_type?: string; message?: string }
}
export function reelConfigureSucceeded(data: unknown): boolean {
  if (!data || typeof data !== "object") return false
  const d = data as { status?: string; posts?: ConfigurePost[] }
  if (d.status && d.status !== "ok") return false
  if (Array.isArray(d.posts) && d.posts.length > 0) {
    return d.posts.every((p) => {
      // An explicit non-NO_ERROR error type is a genuine failure.
      const errType = p.error_info?.error_type
      if (errType && errType !== "NO_ERROR") return false
      // COMPLETED is obviously done.
      if (p.status === "COMPLETED") return true
      // PENDING/IN_PROGRESS with NO_ERROR and an assigned media id means the
      // reel was accepted and is being finalized async — count it as success.
      if (p.status === "PENDING" || p.status === "IN_PROGRESS") {
        return Array.isArray(p.media_ids) && p.media_ids.length > 0
      }
      // No status field at all = treat as accepted.
      return !p.status
    })
  }
  return d.status === "ok"
}

// How long to keep polling configure_to_clips while Instagram is still
// transcoding. When several reels are published back-to-back on the same
// account (e.g. three Post Reel nodes in a row), the server queues the later
// videos and answers configure with HTTP 202 ("accepted, still processing")
// until the transcode finishes — which can take a couple of minutes under load.
// The first reel usually lands inside a few seconds; the retry budget has to be
// generous enough for the ones queued behind it, or they get falsely reported
// as http_202 failures even though the upload was fine.
const CONFIGURE_MAX_ATTEMPTS = 9
// Backoff schedule (seconds) between configure attempts — ramps up then holds,
// ~3.5 min total, matching real server-side transcode waits.
const CONFIGURE_BACKOFF_S = [3, 5, 8, 12, 18, 25, 30, 30, 30]

// HTTP 202 from configure_to_clips is NOT a failure — it means "accepted, media
// still processing". Re-POSTing configure with the same upload_id is safe:
// Instagram dedupes on upload_id and returns the single media once it is ready,
// so retrying can never create a duplicate reel.
export async function configureReelWithRetry(
  ...args: Parameters<typeof ep.configureReel>
): Promise<{ ok: boolean; status: number; detail?: string; data?: unknown }> {
  const [c, uploadId, opts = {}] = args
  let lastStatus = 0
  // Capture the last thing Instagram actually told us (raw body or network
  // error). This is surfaced in the run-log reason so failures show the real
  // cause instead of an opaque "http_202".
  let lastDetail = ""
  for (let attempt = 0; attempt < CONFIGURE_MAX_ATTEMPTS; attempt++) {
    let processing = false
    try {
      // Walk the composer nav journey only on the first attempt; reuse it on
      // 202 polls so the nav chain doesn't grow on every retry.
      const conf = await ep.configureReel(c, uploadId, { ...opts, reuseNav: attempt > 0 })
      lastStatus = conf.status
      lastDetail = summarizeBody(conf.data)
      // Genuinely published.
      if (conf.ok && conf.status !== 202 && reelConfigureSucceeded(conf.data)) {
        return { ok: true, status: conf.status, data: conf.data }
      }
      // 202 (accepted, transcoding) or a 200 whose body still says "processing"
      // are retryable; a real HTTP error (4xx/5xx other than 202) is terminal.
      const bodyProcessing = conf.status === 200 && !reelConfigureSucceeded(conf.data)
      processing = conf.status === 202 || bodyProcessing
      if (!processing) return { ok: false, status: conf.status, detail: lastDetail }
    } catch (e) {
      // Network-level blip (e.g. "socket hang up" when a proxy drops the long
      // configure connection). Treat as retryable rather than a hard failure.
      lastDetail = e instanceof Error ? e.message : String(e)
      lastStatus = lastStatus || 0
      processing = true
    }
    if (attempt < CONFIGURE_MAX_ATTEMPTS - 1) {
      await sleep(CONFIGURE_BACKOFF_S[attempt] * 1000)
    }
  }
  // Exhausted the budget while still processing.
  return { ok: false, status: lastStatus || 202, detail: lastDetail || "still_processing" }
}

// Compact a raw IG response body into a single log-friendly string.
function summarizeBody(data: unknown): string {
  if (data == null) return ""
  if (typeof data === "string") return data.slice(0, 300)
  try {
    return JSON.stringify(data).slice(0, 300)
  } catch {
    return String(data).slice(0, 300)
  }
}
