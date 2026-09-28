// Shared reel-publish orchestrator.
//
// BOTH entry points — the workflow Post Reel/Media node (post-media-runner) and
// the manual publications action — drive reels through THIS single function, so
// the on-wire behavior is byte-for-byte identical no matter which node fires it.
// Previously each caller had its own copy of the upload+configure sequence, which
// drifted; centralizing here guarantees they can't.
//
// The sequence reproduces the captured gallery-reel publish end to end:
//   1. composer opens from the profile        (warmupComposerOpen)
//   2. [human pause: browsing the gallery]
//   3. clip chosen, crop screen               (warmupMediaChosen)
//   4. [human pause: trimming / editing]
//   5. upload_settings   (nav: post-capture editing screens)
//   6. rupload_igvideo   (nav: share sheets)  — the video bytes
//   7. rupload_igphoto   (cover frame, nth_frame, shared upload_id)  [best-effort]
//   8. [human pause: typing the caption on the share sheet]
//   9. header nav tabbed back to the feed
//  10. configure_to_clips (async_publish:1, full body nav_chain)  — with retry
//  11. post-publish resurrected-user check on the feed            [best-effort]
//
// Human pauses are randomized within capped ranges so the cadence looks manual
// without ever letting a node hang. They can be tuned or disabled per caller.

import { InstagramClient } from "@/lib/instagram/client"
import { probeMp4, uniquifyMp4 } from "@/lib/instagram/mp4"
import { NAV } from "@/lib/instagram/nav-chain"
import { warmupComposerOpen, warmupMediaChosen, warmupShareSheet, postPublish } from "@/lib/instagram/reel-warmup"
import { extractCoverFrame, type CoverColors } from "@/lib/instagram/reel-cover"
import { configureReelWithRetry } from "@/lib/instagram/reel-publish"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// A [min, max] millisecond range; the actual wait is uniformly random within it.
export type DelayRange = [number, number]

export interface ReelDelays {
  // Between the composer opening and the clip being chosen (browsing the gallery).
  pick: DelayRange
  // Between choosing the clip and starting the upload (trimming / editing). This
  // is the long pause in the real capture; we cap it hard so nodes never stall.
  edit: DelayRange
  // Between the upload finishing and configure firing (typing the caption).
  caption: DelayRange
}

// Sensible capped defaults. The genuine capture had a multi-minute edit pause;
// we keep the human cadence but cap the total added latency to well under a
// minute so back-to-back nodes stay responsive.
export const DEFAULT_REEL_DELAYS: ReelDelays = {
  pick: [1500, 5000],
  edit: [6000, 22000],
  caption: [2500, 9000],
}

function waitFor(range: DelayRange | undefined, client?: InstagramClient): Promise<void> {
  if (!range) return Promise.resolve()
  const [min, max] = range
  if (max <= 0) return Promise.resolve()
  const lo = Math.max(0, Math.min(min, max))
  const r = client ? client.accountRandom() : Math.random()
  return sleep(Math.round(lo + r * Math.max(0, max - lo)))
}

// Pull the freshly-published reel's media id out of the configure_to_clips
// response so the post-publish follow-ups (dumps 36,37) can reference it. The
// id lives at `media.id` (e.g. "3701...._1010515070"); we fall back to `media.pk`
// or a top-level `media_id` and return undefined if none are present.
function extractMediaId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const root = data as Record<string, unknown>
  const media = root.media
  if (media && typeof media === "object") {
    const m = media as Record<string, unknown>
    if (typeof m.id === "string" && m.id) return m.id
    if (typeof m.pk === "string" && m.pk) return m.pk
    if (typeof m.pk === "number") return String(m.pk)
  }
  if (typeof root.media_id === "string" && root.media_id) return root.media_id
  return undefined
}

export interface ReelFlowInput {
  caption?: string
  // Fallback dimensions when the mp4 probe can't read them (e.g. from the DB row).
  fallbackWidth?: number
  fallbackHeight?: number
  // Per-caller override of the human pause ranges. Pass `false` to run with no
  // artificial delays (e.g. bulk backfills where realism isn't the priority).
  delays?: Partial<ReelDelays> | false
}

export interface ReelFlowResult {
  ok: boolean
  status: number
  detail?: string
  uploadId: string
  // When ok:false — which request actually failed and its IG endpoint. Surfaced
  // verbatim in the run log so a failure points at the exact call (the video
  // byte upload vs configure_to_clips) instead of always being blamed on
  // "configure". undefined on success.
  stage?: string
  endpoint?: string
}

// Publish one reel for one account. Never throws for expected failure modes —
// returns { ok:false, detail } so the caller can log the real reason. Warmup,
// cover upload, and the post-publish check are all best-effort and never abort
// the publish.
export async function publishReelFlow(
  client: InstagramClient,
  buffer: Buffer,
  input: ReelFlowInput = {},
): Promise<ReelFlowResult> {
  const delays: ReelDelays | null =
    input.delays === false ? null : { ...DEFAULT_REEL_DELAYS, ...(input.delays ?? {}) }

  const probe = probeMp4(buffer)
  const width = probe?.width || input.fallbackWidth || 720
  const height = probe?.height || input.fallbackHeight || 1280
  const durationMs = probe?.durationMs || 15000
  // Make this upload's bytes unique so Instagram can't dedupe it against a reel
  // that used the same source file (e.g. two Post Reel nodes sharing one video).
  const uploadBuffer = uniquifyMp4(buffer)
  // Timestamp + random so two back-to-back publishes on one account can never
  // share an upload_id (which is also the session_id correlating video, cover
  // and configure); a plain Date.now() could in theory repeat under fast loops.
  const uploadId = (client.accountNow() + Math.floor(client.accountRandom() * 1000)).toString()
  const waterfallId = client.accountRandomHex(32)
  // Stable ids reused across configure retries so IG dedupes cleanly.
  const publishId = (client.accountNow() + Math.floor(client.accountRandom() * 1000)).toString()
  const compositionId = client.accountUuid().toUpperCase()

  // 1) Composer opens from the profile.
  await warmupComposerOpen(client)
  // 2) Human browses the gallery and picks a clip.
  if (delays) await waitFor(delays.pick, client)
  // 3) Clip chosen — app sits on the crop screen.
  await warmupMediaChosen(client)
  // 4) Human trims / edits before hitting share.
  if (delays) await waitFor(delays.edit, client)

  // 5) upload_settings fires from the post-capture editing screens.
  client.nav.visit(NAV.REEL_COMPOSER_EDIT)
  try {
    await client.uploadSettings({
      uploadId,
      waterfallId,
      durationMs,
      width,
      height,
      fileSize: uploadBuffer.length,
      codec: probe?.codec,
      frameRate: probe?.frameRate,
      hasAudio: probe?.hasAudio,
      rotationAngle: probe?.rotationAngle,
    })
  } catch {
    // best-effort — the upload itself is the source of truth
  }

  // 6) The video bytes upload from the share sheets.
  client.nav.visit(NAV.REEL_COMPOSER_SHARE)
  const up = await client.uploadVideo(uploadBuffer, { uploadId, waterfallId, durationMs, width, height })
  if (!up.ok) {
    return {
      ok: false,
      status: up.status,
      detail: bodyDetail(up.data),
      uploadId,
      stage: "upload_video",
      endpoint: "/rupload_igvideo/",
    }
  }

  // 7) Cover frame (best-effort). Extract a real frame and upload it as the
  //    nth_frame cover sharing the video's upload_id. If ffmpeg is unavailable
  //    the video's extract_cover_frame:"1" makes the server derive the cover.
  let colors: CoverColors | undefined
  try {
    const cover = await extractCoverFrame(buffer, 0)
    if (cover) {
      colors = cover.colors
      await client.uploadReelCover(cover.jpeg, { uploadId })
    }
  } catch (err) {
    console.log("[v0] reel cover upload skipped:", err instanceof Error ? err.message : String(err))
  }

  // 8) The share sheet loads: the app fires its benefit-eligibility / promo /
  //    survey / NUX background batch (dumps 21–33). Best-effort.
  await warmupShareSheet(client)

  // 9) Human types the caption on the share sheet.
  if (delays) await waitFor(delays.caption, client)

  // 10) The user tabs back to the feed while the async publish completes, so the
  //     configure request's HEADER nav-chain sits on feed_timeline (the full
  //     composer journey travels in the body via detachedChain).
  client.nav.visit(NAV.FEED)

  // 11) configure_to_clips with retry (HTTP 202 = still transcoding).
  const conf = await configureReelWithRetry(client, uploadId, {
    caption: input.caption ?? "",
    width,
    height,
    durationMs,
    waterfallId,
    originalWidth: width,
    originalHeight: height,
    publishId,
    compositionId,
    colors,
  })

  // 12) Post-publish follow-ups the app runs back on the feed (dumps 36,37),
  //     keyed off the freshly-published reel's media id. Best-effort.
  if (conf.ok) await postPublish(client, extractMediaId(conf.data))

  return {
    ok: conf.ok,
    status: conf.status,
    detail: conf.detail,
    uploadId,
    stage: conf.ok ? undefined : "configure_to_clips",
    endpoint: conf.ok ? undefined : "/api/v1/media/configure_to_clips/",
  }
}

function bodyDetail(data: unknown): string {
  if (data == null) return ""
  if (typeof data === "string") return data.slice(0, 300)
  try {
    return JSON.stringify(data).slice(0, 300)
  } catch {
    return String(data).slice(0, 300)
  }
}
