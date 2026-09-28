import { InstagramClient } from "@/lib/instagram/client"
import { probeMp4 } from "@/lib/instagram/mp4"
import * as ep from "@/lib/instagram/endpoints"
import { NAV } from "@/lib/instagram/nav-chain"
import { loadMediaBuffer } from "@/lib/media/storage"
import { probeImageSize } from "@/lib/media/image-size"
import { publishReelFlow } from "@/lib/instagram/reel-flow"
import { pythonIgEnabled, publishReelViaPython } from "@/lib/instagram/py-bridge"
import { db } from "@/lib/db"
import { igAccounts, igMedia } from "@/lib/db/schema"
import { and, eq, inArray } from "drizzle-orm"
import type { MediaItemRef, PostMediaConfig } from "@/lib/workflows/types"

type Account = typeof igAccounts.$inferSelect

// Tag the files this account just posted as used-by-account, so the media
// library can show ownership. Uniqueized copies are separate rows and stay
// unmarked until they are themselves published.
async function markItemsUsed(account: Account, items: MediaItemRef[]) {
  if (account.userId == null) return
  const ids = [...new Set(items.map((i) => i.mediaId).filter((n): n is number => typeof n === "number" && n > 0))]
  if (ids.length === 0) return
  await db
    .update(igMedia)
    .set({ usedByAccountId: account.id })
    .where(and(eq(igMedia.userId, account.userId), inArray(igMedia.id, ids)))
}

// Stamp the account's last successful MEDIA publish time (reel/post/carousel).
// Stories use a different runner and intentionally do not call this.
async function markPosted(account: Account) {
  await db.update(igAccounts).set({ lastPostAt: new Date() }).where(eq(igAccounts.id, account.id))
}

export interface PostMediaOutcome {
  accountId: number
  status: "done" | "skipped" | "failed"
  reason?: string
  // On failure: the exact IG endpoint of the request that failed and its HTTP
  // code, so the run log / Live Logs can show WHICH request errored (and its
  // URL) rather than a bare reason.
  endpoint?: string
  responseStatus?: number
}

// Reads locally-stored media from disk (legacy absolute blob URLs still fetch
// over HTTP). Detached runners have no request origin, so we can't rely on
// fetching a relative route URL.
async function fetchBuffer(url: string): Promise<Buffer> {
  return loadMediaBuffer(url)
}

// Compact a raw IG response body into a short string for the run-log reason so
// failures show what Instagram actually returned instead of a bare status code.
function bodyDetail(data: unknown): string {
  if (data == null) return ""
  if (typeof data === "string") return data.slice(0, 300)
  try {
    return JSON.stringify(data).slice(0, 300)
  } catch {
    return String(data).slice(0, 300)
  }
}

// Upload one video (probe -> upload_settings -> rupload_igvideo) and return the
// resolved upload id + dimensions for the configure call.
//
// When `reelStaging` is set (single-video Post Reel), we advance the shared nav
// chain to the exact surface the real app is on for each request, reproducing
// the captured progression: upload_settings fires from the post-capture editing
// screen (…:clips_postcapture_camera) and the rupload bytes fire from the share
// sheet (…:IGSundialShareSheetV2ViewController). configure_to_clips then walks
// the final OA-reuse NUX screen. Carousel children skip this (different composer).
async function uploadVideoFull(client: InstagramClient, buffer: Buffer, opts?: { reelStaging?: boolean }) {
  const probe = probeMp4(buffer)
  const width = probe?.width || 720
  const height = probe?.height || 1280
  const durationMs = probe?.durationMs || 15000
  const uploadId = client.accountNow().toString()
  const waterfallId = client.accountRandomHex(32)
  try {
    // Stage 1: post-capture editing screens precede the transcode negotiation.
    if (opts?.reelStaging) client.nav.visit(NAV.REEL_COMPOSER_EDIT)
    // Forward the REAL probed codec/fps/audio so upload_settings describes the
    // actual bytes rather than hardcoded HEVC/30fps/audio values.
    await client.uploadSettings({
      uploadId,
      waterfallId,
      durationMs,
      width,
      height,
      fileSize: buffer.length,
      codec: probe?.codec,
      frameRate: probe?.frameRate,
      hasAudio: probe?.hasAudio,
      rotationAngle: probe?.rotationAngle,
    })
  } catch {
    // best-effort
  }
  // Stage 2: the share sheets precede the actual byte upload.
  if (opts?.reelStaging) client.nav.visit(NAV.REEL_COMPOSER_SHARE)
  const up = await client.uploadVideo(buffer, { uploadId, waterfallId, durationMs, width, height })
  return { ok: up.ok, status: up.status, uploadId: up.uploadId, data: up.data, width, height, durationMs, waterfallId }
}

// Execute the Post Media step for ONE account.
//
//   • 1 item, image  -> rupload_igphoto + /media/configure/        (single post)
//   • 1 item, video  -> rupload_igvideo + /media/configure_to_clips/ (reel)
//   • 2+ items       -> each child uploaded, then /media/configure_sidecar/ (carousel)
//
// Accounts with no media configured are skipped.
export async function runPostMediaForAccount(opts: {
  account: Account
  config: PostMediaConfig
}): Promise<PostMediaOutcome> {
  const { account, config } = opts
  const accountId = account.id
  // This runner backs BOTH the Post Media node (assignment.items: MediaItemRef[])
  // and the Post Reel node (assignment.{mediaId,mediaUrl,mediaName} — a single
  // reel, no `items` array). Read the assignment loosely so we can normalize the
  // legacy reel shape into a one-item list — otherwise Post Reel skips "no_media".
  const assignment = config.assignments.find((a) => a.accountId === accountId) as
    | {
        items?: MediaItemRef[]
        mediaId?: number | null
        mediaUrl?: string | null
        mediaName?: string | null
        description?: string
      }
    | undefined

  let items: MediaItemRef[] = []
  if (Array.isArray(assignment?.items) && assignment.items.length > 0) {
    items = assignment.items.slice(0, 20)
  } else if (assignment?.mediaUrl && assignment.mediaId != null) {
    items = [{ mediaId: assignment.mediaId, mediaUrl: assignment.mediaUrl, mediaName: assignment.mediaName ?? "", kind: "video" }]
  }
  if (items.length === 0) return { accountId, status: "skipped", reason: "no_media" }

  const caption = assignment?.description ?? ""
  const c = new InstagramClient(account)

  try {
    // Carousel — 2+ items become a sidecar.
    if (items.length > 1) {
      const children: ep.SidecarChild[] = []
      for (const item of items) {
        const buffer = await fetchBuffer(item.mediaUrl)
        if (item.kind === "video") {
          const up = await uploadVideoFull(c, buffer)
          if (!up.ok)
            return {
              accountId,
              status: "failed",
              reason: `upload_video (/rupload_igvideo/) → HTTP ${up.status}: ${bodyDetail(up.data)}`,
              endpoint: "/rupload_igvideo/",
              responseStatus: up.status,
            }
          children.push({ uploadId: up.uploadId, kind: "video", width: up.width, height: up.height, durationMs: up.durationMs })
        } else {
          const up = await c.uploadPhoto(buffer)
          if (!up.ok)
            return {
              accountId,
              status: "failed",
              reason: `upload_photo (/rupload_igphoto/) → HTTP ${up.status}: ${bodyDetail(up.data)}`,
              endpoint: "/rupload_igphoto/",
              responseStatus: up.status,
            }
          // Pass the photo's REAL dimensions so the carousel keeps each slide at
          // its actual resolution instead of forcing 1080x1080 (which made
          // non-square slides get re-cropped by Instagram).
          const size = await probeImageSize(buffer)
          children.push({ uploadId: up.uploadId, kind: "image", width: size?.width, height: size?.height })
        }
      }
      const conf = await ep.configureSidecar(c, children, { caption })
      if (conf.ok) {
        await markItemsUsed(account, items)
        await markPosted(account)
      }
      return conf.ok
        ? { accountId, status: "done" }
        : {
            accountId,
            status: "failed",
            reason: `configure_sidecar (/api/v1/media/configure_sidecar/) → HTTP ${conf.status}: ${bodyDetail(conf.data)}`,
            endpoint: "/api/v1/media/configure_sidecar/",
            responseStatus: conf.status,
          }
    }

    // Single item.
    const item = items[0]
    const buffer = await fetchBuffer(item.mediaUrl)
    if (item.kind === "video") {
      // Single video = a reel. The entire captured gallery-reel journey (composer
      // warmup, human pauses, upload_settings, rupload_igvideo, cover frame,
      // configure_to_clips, post-publish check) lives in the shared orchestrator
      // so this node and the manual publications action behave identically.
      //
      // When the FastAPI service is available (IG_SERVICE_URL set), delegate the
      // whole flow to it — it egresses through the same uTLS sidecar, so the wire
      // behavior is identical. Otherwise run the in-process TypeScript flow.
      const conf = pythonIgEnabled()
        ? await publishReelViaPython(account, buffer, { caption, fallbackWidth: 720, fallbackHeight: 1280 })
        : await publishReelFlow(c, buffer, { caption, fallbackWidth: 720, fallbackHeight: 1280 })
      if (conf.ok) {
        // Persist any server-rotated claim the Python service surfaced.
        if ("claim" in conf && conf.claim && conf.claim !== account.claim) {
          await db.update(igAccounts).set({ claim: conf.claim }).where(eq(igAccounts.id, account.id))
        }
        await markItemsUsed(account, items)
        await markPosted(account)
      }
      if (conf.ok) {
        return { accountId, status: "done" }
      }
      // publishReelFlow / publishReelViaPython tell us which request failed and
      // its endpoint; fall back to configure_to_clips when a legacy result omits
      // them. The reason names the failing request so it's obvious in Live Logs.
      const stage = "stage" in conf && conf.stage ? conf.stage : "configure_to_clips"
      const endpoint =
        "endpoint" in conf && conf.endpoint ? conf.endpoint : "/api/v1/media/configure_to_clips/"
      return {
        accountId,
        status: "failed",
        reason: `${stage} (${endpoint}) → HTTP ${conf.status}: ${conf.detail ?? ""}`,
        endpoint,
        responseStatus: conf.status,
      }
    }
    const up = await c.uploadPhoto(buffer)
    if (!up.ok)
      return {
        accountId,
        status: "failed",
        reason: `upload_photo (/rupload_igphoto/) → HTTP ${up.status}: ${bodyDetail(up.data)}`,
        endpoint: "/rupload_igphoto/",
        responseStatus: up.status,
      }
    const conf = await ep.configurePhoto(c, up.uploadId, { caption })
    if (conf.ok) {
      await markItemsUsed(account, items)
      await markPosted(account)
    }
    return conf.ok
      ? { accountId, status: "done" }
      : {
          accountId,
          status: "failed",
          reason: `configure (/api/v1/media/configure/) → HTTP ${conf.status}: ${bodyDetail(conf.data)}`,
          endpoint: "/api/v1/media/configure/",
          responseStatus: conf.status,
        }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "post_failed" }
  }
}
