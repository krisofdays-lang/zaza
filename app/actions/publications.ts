"use server"

import { db } from "@/lib/db"
import { igPublications, igAccounts, igMedia, igRunLogs, type IgMedia, type IgAccount } from "@/lib/db/schema"
import { eq, and, desc, inArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { requireUserId } from "@/lib/auth/session"
import { loadMediaBuffer } from "@/lib/media/storage"
import { probeImageSize } from "@/lib/media/image-size"
import { publishReelFlow } from "@/lib/instagram/reel-flow"
import { markMediaUsedByAccount } from "@/app/actions/storage"
import { InstagramClient } from "@/lib/instagram/client"
import { probeMp4 } from "@/lib/instagram/mp4"
import * as ep from "@/lib/instagram/endpoints"
import { publishStory, publishHighlight } from "@/lib/instagram/story"

export type PubType = "reel" | "post" | "story" | "highlight"

export interface LinkSticker {
  url: string
  text?: string
  rotation?: number
  size?: number
  // Normalized centre of the sticker on the story canvas (0–1).
  x?: number
  y?: number
}

export interface Assignment {
  accountId: number
  // Ordered media for this account. A single id => normal post/reel/story;
  // 2+ ids (post type only) => carousel via /media/configure_sidecar/.
  mediaIds: number[]
  // Per-account overrides set in the composer's media card.
  caption?: string
  linkSticker?: LinkSticker | null
}

export interface PublicationInput {
  type: PubType
  caption: string
  groupId?: number | null
  accountIds: number[]
  assignments: Assignment[]
  linkSticker?: LinkSticker | null
  // Highlight name (title) used when type === "highlight".
  highlightName?: string
  // How many accounts publish in parallel (1 = sequential, up to 20).
  concurrency?: number
}

export async function getPublications() {
  const userId = await requireUserId()
  return db.select().from(igPublications).where(eq(igPublications.userId, userId)).orderBy(desc(igPublications.createdAt))
}

export async function createPublication(input: PublicationInput) {
  const userId = await requireUserId()
  const [row] = await db
    .insert(igPublications)
    .values({
      userId,
      type: input.type,
      caption: input.caption,
      groupId: input.groupId ?? null,
      accountIds: input.accountIds,
      assignments: input.assignments,
      linkSticker: input.linkSticker ?? null,
      concurrency: input.concurrency ?? null,
      status: "draft",
    })
    .returning()
  revalidatePath("/publications")
  return row
}

export async function deletePublication(id: number) {
  const userId = await requireUserId()
  await db.delete(igPublications).where(and(eq(igPublications.id, id), eq(igPublications.userId, userId)))
  revalidatePath("/publications")
}

// Reads locally-stored media from disk (and still fetches legacy absolute blob
// URLs over HTTP) so publishing works without a request origin.
async function fetchBuffer(url: string): Promise<Buffer> {
  return loadMediaBuffer(url)
}

// Compact a raw IG response body into a short string so publish failures show
// what Instagram actually returned instead of just a status code.
function bodyDetail(data: unknown): string {
  if (data == null) return ""
  if (typeof data === "string") return data.slice(0, 300)
  try {
    return JSON.stringify(data).slice(0, 300)
  } catch {
    return String(data).slice(0, 300)
  }
}

interface RunOutcome {
  account: string
  ok: boolean
  status: number
  message: string
}

// Default number of accounts publishing in parallel when the publication has no
// explicit concurrency set.
const PUBLISH_CONCURRENCY = 4

// Run each assignment with bounded parallelism. Accounts sharing a rotating
// proxy (same laneKey) run serially in one lane so their rotations never
// collide; accounts with no rotation URL each get their own lane and run in
// parallel, up to `limit` lanes at once. Results order is not significant.
async function runAssignmentLanes(
  assignments: Assignment[],
  laneKey: (a: Assignment) => string,
  limit: number,
  fn: (a: Assignment) => Promise<RunOutcome>,
): Promise<RunOutcome[]> {
  const serial = new Map<string, Assignment[]>()
  const free: Assignment[][] = []
  for (const a of assignments) {
    const key = laneKey(a).trim()
    if (key) {
      const arr = serial.get(key) ?? []
      arr.push(a)
      serial.set(key, arr)
    } else {
      free.push([a])
    }
  }
  const lanes = [...free, ...serial.values()]
  const out: RunOutcome[] = []
  let cursor = 0
  async function worker() {
    while (cursor < lanes.length) {
      const lane = lanes[cursor++]
      for (const a of lane) out.push(await fn(a))
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, lanes.length)) }, worker))
  return out
}

// Upload a single video's bytes (probe -> upload_settings -> rupload_igvideo)
// and return the resolved upload id + dimensions for use in a configure call.
async function uploadVideoFull(
  client: InstagramClient,
  buffer: Buffer,
  item: IgMedia,
): Promise<{ ok: boolean; status: number; uploadId: string; data?: unknown; width: number; height: number; durationMs: number; waterfallId: string }> {
  const probe = probeMp4(buffer)
  const width = probe?.width || item.width || 720
  const height = probe?.height || item.height || 1280
  const durationMs = probe?.durationMs || 15000
  const uploadId = client.accountNow().toString()
  const waterfallId = client.accountRandomHex(32)
  try {
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
    // best-effort — the upload itself is the source of truth
  }
  const up = await client.uploadVideo(buffer, { uploadId, waterfallId, durationMs, width, height })
  return { ok: up.ok, status: up.status, uploadId: up.uploadId, data: up.data, width, height, durationMs, waterfallId }
}

// Publish a story (optionally promoted to a highlight) for each assignment.
// Stories take a single media item; a link sticker can be attached per account.
// Highlights post the story, ensure it's archived, then build the highlight.
async function runStoryPublication(
  input: PublicationInput,
): Promise<{ ok: boolean; results: RunOutcome[]; error?: string }> {
  if (!input.assignments.length) {
    return { ok: false, results: [], error: "No media assigned to any account" }
  }
  const isHighlight = input.type === "highlight"

  const userId = await requireUserId()
  const accountIds = [...new Set(input.assignments.map((a) => a.accountId))]
  const mediaIds = [...new Set(input.assignments.flatMap((a) => a.mediaIds))]
  const accounts = await db
    .select()
    .from(igAccounts)
    .where(and(eq(igAccounts.userId, userId), inArray(igAccounts.id, accountIds)))
  const media = mediaIds.length
    ? await db.select().from(igMedia).where(and(eq(igMedia.userId, userId), inArray(igMedia.id, mediaIds)))
    : []
  const accountMap = new Map<number, IgAccount>(accounts.map((a) => [a.id, a]))
  const mediaMap = new Map<number, IgMedia>(media.map((m) => [m.id, m]))

  // How many accounts publish in parallel (1 = sequential). Clamp to 1..20.
  const limit = Math.min(Math.max(input.concurrency ?? PUBLISH_CONCURRENCY, 1), 20)

  const results = await runAssignmentLanes(
    input.assignments,
      // Serialize by proxy when present, else by account id — so multiple reels
      // targeting the SAME no-proxy account never run concurrently (which made
      // the 2nd/3rd back-to-back reel fail: IG saw parallel composer sessions on
      // one account). Different accounts still get distinct keys → run in parallel.
      (a) => accountMap.get(a.accountId)?.rotationUrl?.trim() || `acct:${a.accountId}`,
    limit,
    async (assignment): Promise<RunOutcome> => {
    const account = accountMap.get(assignment.accountId)
    const item = assignment.mediaIds.map((id) => mediaMap.get(id)).find((m): m is IgMedia => Boolean(m))
    if (!account || !item) {
      return { account: account?.label ?? `#${assignment.accountId}`, ok: false, status: 0, message: "Missing account or media" }
    }

    const client = new InstagramClient(account)
    await client.rotateProxy()

    try {
      const buffer = await fetchBuffer(item.blobUrl)
      const link = assignment.linkSticker ?? null
      const mediaInput = {
        buffer,
        kind: item.kind === "video" ? ("video" as const) : ("image" as const),
        width: item.width ?? undefined,
        height: item.height ?? undefined,
      }

      const res = isHighlight
        ? await publishHighlight(client, mediaInput, {
            title: input.highlightName || "Highlights",
            link,
          })
        : await publishStory(client, mediaInput, link)

      await db.insert(igRunLogs).values({
        userId,
        accountId: account.id,
        action: `publish_${input.type}`,
        status: res.ok ? "ok" : "error",
        responseCode: res.status,
        message: res.message.slice(0, 500),
      })
      if (res.ok) await markMediaUsedByAccount(userId, account.id, assignment.mediaIds)
      return { account: account.label, ok: res.ok, status: res.status, message: res.message }
    } catch (e) {
      const message = e instanceof Error ? e.message : "failed"
      await db.insert(igRunLogs).values({
        userId,
        accountId: account.id,
        action: `publish_${input.type}`,
        status: "error",
        message: message.slice(0, 500),
      })
      return { account: account.label, ok: false, status: 0, message }
    }
    },
  )

  return { ok: results.some((r) => r.ok), results }
}

// Publish a post or reel for each assignment. Stories/highlights are delegated
// to runStoryPublication, which handles the upload + configure_to_story flow.
export async function runPublication(input: PublicationInput): Promise<{ ok: boolean; results: RunOutcome[]; error?: string }> {
  if (input.type === "story" || input.type === "highlight") {
    return runStoryPublication(input)
  }
  if (!input.assignments.length) {
    return { ok: false, results: [], error: "No media assigned to any account" }
  }

  const userId = await requireUserId()
  const accountIds = [...new Set(input.assignments.map((a) => a.accountId))]
  const mediaIds = [...new Set(input.assignments.flatMap((a) => a.mediaIds))]
  const accounts = await db
    .select()
    .from(igAccounts)
    .where(and(eq(igAccounts.userId, userId), inArray(igAccounts.id, accountIds)))
  const media = mediaIds.length
    ? await db.select().from(igMedia).where(and(eq(igMedia.userId, userId), inArray(igMedia.id, mediaIds)))
    : []
  const accountMap = new Map<number, IgAccount>(accounts.map((a) => [a.id, a]))
  const mediaMap = new Map<number, IgMedia>(media.map((m) => [m.id, m]))

  // How many accounts publish in parallel (1 = sequential). Clamp to 1..20.
  const limit = Math.min(Math.max(input.concurrency ?? PUBLISH_CONCURRENCY, 1), 20)

  const results = await runAssignmentLanes(
    input.assignments,
      // Serialize by proxy when present, else by account id — so multiple reels
      // targeting the SAME no-proxy account never run concurrently (which made
      // the 2nd/3rd back-to-back reel fail: IG saw parallel composer sessions on
      // one account). Different accounts still get distinct keys → run in parallel.
      (a) => accountMap.get(a.accountId)?.rotationUrl?.trim() || `acct:${a.accountId}`,
    limit,
    async (assignment): Promise<RunOutcome> => {
    const account = accountMap.get(assignment.accountId)
    // Resolve assigned media, preserving the order chosen in the composer.
    const items = assignment.mediaIds.map((id) => mediaMap.get(id)).filter((m): m is IgMedia => Boolean(m))
    if (!account || items.length === 0) {
      return { account: account?.label ?? `#${assignment.accountId}`, ok: false, status: 0, message: "Missing account or media" }
    }

    const client = new InstagramClient(account)
    await client.rotateProxy()

    // Each card can carry its own caption; fall back to a shared one if unset.
    const caption = assignment.caption ?? input.caption

    try {
      let ok = false
      let status = 0
      let message = ""

      // Reels are always a single video; posts can be 1 item (single configure)
      // or 2+ items (carousel via configure_sidecar).
      if (input.type === "post" && items.length > 1) {
        // Carousel: upload each child (photo or video) then configure_sidecar.
        const children: ep.SidecarChild[] = []
        let uploadFailed = ""
        for (const child of items.slice(0, 20)) {
          const buffer = await fetchBuffer(child.blobUrl)
          if (child.kind === "video") {
            const up = await uploadVideoFull(client, buffer, child)
            if (!up.ok) {
              uploadFailed = `Upload failed (HTTP ${up.status}): ${bodyDetail(up.data)}`
              status = up.status
              break
            }
            children.push({ uploadId: up.uploadId, kind: "video", width: up.width, height: up.height, durationMs: up.durationMs })
          } else {
            const up = await client.uploadPhoto(buffer)
            if (!up.ok) {
              uploadFailed = `Upload failed (HTTP ${up.status}): ${bodyDetail(up.data)}`
              status = up.status
              break
            }
            // Prefer the library's stored dimensions; if absent, probe the bytes
            // so the carousel keeps each slide's real resolution rather than
            // defaulting to a square that forces Instagram to re-crop it.
            const size = child.width && child.height ? { width: child.width, height: child.height } : await probeImageSize(buffer)
            children.push({ uploadId: up.uploadId, kind: "image", width: size?.width ?? 1080, height: size?.height ?? 1080 })
          }
        }
        if (uploadFailed) {
          message = uploadFailed
        } else {
          const conf = await ep.configureSidecar(client, children, { caption })
          ok = conf.ok
          status = conf.status
          message = conf.ok
            ? `Published carousel (${children.length})`
            : `Configure failed (HTTP ${conf.status}): ${bodyDetail(conf.data)}`
        }
      } else if (input.type === "post" && items[0].kind === "image") {
        // Single photo post.
        const buffer = await fetchBuffer(items[0].blobUrl)
        const up = await client.uploadPhoto(buffer)
        if (!up.ok) {
          message = `Upload failed (HTTP ${up.status}): ${bodyDetail(up.data)}`
          status = up.status
        } else {
          const conf = await ep.configurePhoto(client, up.uploadId, {
            caption,
            width: items[0].width ?? 1080,
            height: items[0].height ?? 1080,
          })
          ok = conf.ok
          status = conf.status
          message = conf.ok ? "Published post" : `Configure failed (HTTP ${conf.status}): ${bodyDetail(conf.data)}`
        }
      } else {
        // Reel, or a single-video post — the full captured gallery-reel journey
        // (composer warmup, human pauses, upload_settings, rupload_igvideo, cover
        // frame, configure_to_clips) runs through the shared orchestrator so this
        // manual action and the workflow Post Reel node behave identically.
        const video = items[0]
        const buffer = await fetchBuffer(video.blobUrl)
        const conf = await publishReelFlow(client, buffer, {
          caption,
          fallbackWidth: video.width ?? 720,
          fallbackHeight: video.height ?? 1280,
        })
        ok = conf.ok
        status = conf.status
        message = conf.ok ? "Published reel" : `Reel not published (HTTP ${conf.status}): ${conf.detail ?? ""}`
      }

      await db.insert(igRunLogs).values({
        userId,
        accountId: account.id,
        action: `publish_${input.type}`,
        status: ok ? "ok" : "error",
        responseCode: status,
        message: message.slice(0, 500),
      })
      // Tag the exact files this account just published as used-by-account.
      if (ok) {
        await markMediaUsedByAccount(userId, account.id, assignment.mediaIds)
        // Stamp the last media publish time (reel/post/carousel; stories return early above).
        await db.update(igAccounts).set({ lastPostAt: new Date() }).where(eq(igAccounts.id, account.id))
      }
      return { account: account.label, ok, status, message }
    } catch (e) {
      const message = e instanceof Error ? e.message : "failed"
      await db.insert(igRunLogs).values({
        userId,
        accountId: account.id,
        action: `publish_${input.type}`,
        status: "error",
        message: message.slice(0, 500),
      })
      return { account: account.label, ok: false, status: 0, message }
    }
    },
  )

  return { ok: results.some((r) => r.ok), results }
}

// Convenience: create the publication record then run it.
export async function publishNow(input: PublicationInput) {
  const userId = await requireUserId()
  const record = await createPublication(input)
  const run = await runPublication(input)
  await db
    .update(igPublications)
    .set({ status: run.ok ? "done" : "error", result: run.results })
    .where(and(eq(igPublications.id, record.id), eq(igPublications.userId, userId)))
  revalidatePath("/publications")
  return run
}
