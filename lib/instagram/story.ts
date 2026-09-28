import { InstagramClient } from "@/lib/instagram/client"
import { probeMp4 } from "@/lib/instagram/mp4"
import * as ep from "@/lib/instagram/endpoints"
import type { StoryLinkSticker } from "@/lib/instagram/endpoints"
import { bakeStoryPhotoWithLink, type BakeResult } from "@/lib/instagram/story-bake"

export type { StoryLinkSticker }

export interface StoryMediaInput {
  buffer: Buffer
  kind: "image" | "video"
  width?: number
  height?: number
}

export interface StoryResult {
  ok: boolean
  status: number
  mediaId?: string
  message: string
}

// Live-Logs sink. The workflow runner passes a callback that writes each entry
// into `ig_run_logs`, so every request in the story/highlight flow (validate,
// upload, configure, archive, create_reel) surfaces in the workflow's Live Logs
// together with the server's response body when something fails.
export type StoryLog = (entry: {
  action: string
  message: string
  ok: boolean
  status?: number
  url?: string
}) => void | Promise<void>

// How long to wait after posting the story before building the highlight, so
// Instagram has time to index the fresh story into the archive (otherwise
// create_reel races the indexing and fails / needs retries).
const STORY_INDEX_DELAY_MS = 6000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Compact, log-safe preview of a response body.
function bodyPreview(data: unknown): string {
  try {
    const s = typeof data === "string" ? data : JSON.stringify(data)
    if (!s) return ""
    return s.length > 600 ? `${s.slice(0, 600)}…` : s
  } catch {
    return ""
  }
}

// Upload the story media (photo or video) and configure it as a story, attaching
// a link sticker when one is provided. Validates the link URL first (mirrors the
// genuine app flow). Returns the new story's media id on success.
export async function publishStory(
  client: InstagramClient,
  media: StoryMediaInput,
  link?: StoryLinkSticker | null,
  log?: StoryLog,
): Promise<StoryResult> {
  // Validate the optional link URL before uploading anything.
  if (link?.url) {
    try {
      const v = await ep.validateStoryUrl(client, link.url)
      await log?.({
        action: "Story · validate URL",
        message: v.ok
          ? `Ссылка проверена (HTTP ${v.status})`
          : `Проверка ссылки: HTTP ${v.status} — ${bodyPreview(v.data)}`,
        ok: v.ok,
        status: v.status,
        url: v.url,
      })
    } catch (e) {
      // best-effort — IG sometimes 200s with status:ok, sometimes ignores it
      await log?.({
        action: "Story · validate URL",
        message: `Проверка ссылки не удалась: ${e instanceof Error ? e.message : "error"}`,
        ok: false,
      })
    }
  }

  let uploadId: string
  let status = 0
  let width = media.width ?? 1080
  let height = media.height ?? 1920
  // Set when we bake the link pill into a photo — carries the exact normalized
  // geometry of the baked pill so the tap zone aligns with it.
  let bakedBox: BakeResult["box"] | null = null

  if (media.kind === "video") {
    const probe = probeMp4(media.buffer)
    width = probe?.width || width
    height = probe?.height || height
    const durationMs = probe?.durationMs || 15000
    const id = client.accountNow().toString()
    const waterfallId = client.accountRandomHex(32)
    try {
      await client.uploadSettings({ uploadId: id, waterfallId, durationMs, width, height, fileSize: media.buffer.length })
    } catch {
      // best-effort
    }
    const up = await client.uploadVideo(media.buffer, { uploadId: id, waterfallId, durationMs, width, height })
    await log?.({
      action: "Story · upload video",
      message: up.ok ? `Видео загружено (HTTP ${up.status})` : `Загрузка видео: HTTP ${up.status} — ${bodyPreview(up.data)}`,
      ok: up.ok,
      status: up.status,
    })
    if (!up.ok) return { ok: false, status: up.status, message: `Upload failed (HTTP ${up.status})` }
    uploadId = up.uploadId
  } else {
    // For photos, bake the link pill straight into the image (Instagram's
    // mobile API does not reliably render the link sticker from the payload, so
    // the visible pill must live in the pixels). The photo keeps its ORIGINAL
    // resolution — baking no longer resizes or letterboxes it. The returned box
    // is reused as the tappable link geometry.
    let photo = media.buffer
    if (link?.url) {
      try {
        const baked = await bakeStoryPhotoWithLink(media.buffer, {
          url: link.url,
          text: link.text,
          x: link.x,
          y: link.y,
          size: link.size,
          rotation: link.rotation,
        })
        photo = baked.buffer
        bakedBox = baked.box
        width = baked.width
        height = baked.height
      } catch {
        // If baking fails, fall back to uploading the original photo.
      }
    }
    const up = await client.uploadPhoto(photo)
    await log?.({
      action: "Story · upload photo",
      message: up.ok ? `Фото загружено (HTTP ${up.status})` : `Загрузка фото: HTTP ${up.status} — ${bodyPreview(up.data)}`,
      ok: up.ok,
      status: up.status,
    })
    if (!up.ok) return { ok: false, status: up.status, message: `Upload failed (HTTP ${up.status})` }
    uploadId = up.uploadId
  }

  const conf = await ep.configureStory(client, uploadId, { width, height, link: link ?? null, linkBox: bakedBox })
  status = conf.status
  await log?.({
    action: link?.url ? "Story · configure (со ссылкой)" : "Story · configure",
    message: conf.ok
      ? `Сторис опубликована (HTTP ${status})`
      : `Configure: HTTP ${status} — ${bodyPreview(conf.data)}`,
    ok: conf.ok,
    status,
    url: conf.url,
  })
  if (!conf.ok) return { ok: false, status, message: `Configure failed (HTTP ${status})` }

  const data = conf.data as { media?: { id?: string; pk?: string | number } } | undefined
  const mediaId = data?.media?.id ?? (data?.media?.pk != null ? `${data.media.pk}_${client.uid}` : undefined)
  return { ok: true, status, mediaId, message: "Posted story" }
}

// Post a story, make sure it lands in the archive, then build a highlight from
// the freshly posted story media. `title` is the highlight name.
export async function publishHighlight(
  client: InstagramClient,
  media: StoryMediaInput,
  opts: { title: string; link?: StoryLinkSticker | null },
  log?: StoryLog,
): Promise<StoryResult> {
  // Highlights can only be built from archived stories — ensure the flag is on.
  try {
    const cur = await ep.getSaveStoryToArchive(client)
    const enabled = cur.data?.data?.xdt_api__v1__settings__get_bool?.value
    if (enabled !== true) {
      await ep.setSaveStoryToArchive(client, true)
      await log?.({ action: "Highlight · archive setting", message: "Включил «сохранять в архив»", ok: true })
    }
  } catch {
    // best-effort — try setting it on regardless
    try {
      await ep.setSaveStoryToArchive(client, true)
    } catch {
      // ignore
    }
  }

  const story = await publishStory(client, media, opts.link, log)
  if (!story.ok) return story
  if (!story.mediaId) {
    return { ok: false, status: story.status, message: "Story posted but no media id returned" }
  }

  // Give Instagram time to index the fresh story into the archive before we try
  // to build a highlight from it — otherwise create_reel races the indexing and
  // fails (HTTP 400), which is the main reason highlights didn't post.
  await log?.({
    action: "Highlight · ожидание",
    message: `Пауза ${Math.round(STORY_INDEX_DELAY_MS / 1000)} сек — жду индексацию сторис в архиве`,
    ok: true,
  })
  await sleep(STORY_INDEX_DELAY_MS)

  // Open the archive (mirrors the real client flow before creating a highlight).
  try {
    const arch = await ep.storyArchive(client)
    await log?.({
      action: "Highlight · archive",
      message: `Открыл архив сторис (HTTP ${arch.status})`,
      ok: arch.ok,
      status: arch.status,
      url: arch.url,
    })
  } catch {
    // best-effort
  }

  const title = (opts.title || "Highlights").slice(0, 16)

  // `/highlights/create_reel/` is NOT idempotent — every call builds a brand-new
  // highlight, and it frequently returns a non-ok status (e.g. HTTP 400 while the
  // freshly posted story is still being indexed into the archive) even though the
  // highlight WAS created. Blindly retrying therefore produced multiple duplicate
  // highlights. So before each retry we read the highlights tray and, if a new
  // highlight has appeared since we started, we treat the create as successful and
  // stop — the retry only fires when nothing was actually created.
  const before = await snapshotHighlightIds(client)

  let created = await ep.createHighlight(client, { title, mediaIds: [story.mediaId] })
  await log?.({
    action: "Highlight · create_reel",
    message: created.ok
      ? `Хайлайт создан (HTTP ${created.status})`
      : `create_reel: HTTP ${created.status} — ${bodyPreview(created.data)}`,
    ok: created.ok,
    status: created.status,
    url: created.url,
  })
  for (let attempt = 1; !created.ok && attempt <= 4; attempt++) {
    await sleep(2000 * attempt) // 2s, 4s, 6s, 8s
    // Did the previous (error-reported) attempt actually create the highlight?
    if (await highlightAppeared(client, before)) {
      await log?.({ action: "Highlight · create_reel", message: "Хайлайт уже появился в архиве — успех", ok: true })
      return { ok: true, status: 200, mediaId: story.mediaId, message: "Created highlight" }
    }
    try {
      await ep.storyArchive(client)
    } catch {
      // best-effort
    }
    created = await ep.createHighlight(client, { title, mediaIds: [story.mediaId] })
    await log?.({
      action: "Highlight · create_reel (повтор)",
      message: created.ok
        ? `Хайлайт создан со ${attempt + 1}-й попытки (HTTP ${created.status})`
        : `Повтор ${attempt}: HTTP ${created.status} — ${bodyPreview(created.data)}`,
      ok: created.ok,
      status: created.status,
      url: created.url,
    })
  }

  if (!created.ok) {
    // Final safety check — the last attempt may have created it despite the error.
    if (await highlightAppeared(client, before)) {
      return { ok: true, status: 200, mediaId: story.mediaId, message: "Created highlight" }
    }
    return { ok: false, status: created.status, mediaId: story.mediaId, message: `Highlight failed (HTTP ${created.status})` }
  }
  return { ok: true, status: created.status, mediaId: story.mediaId, message: "Created highlight" }
}

// Read the current set of highlight ids from the user's highlights tray. Used to
// detect whether a create_reel call actually created a highlight even when it
// reported an error, so retries never produce duplicates. Best-effort: returns an
// empty set on any failure.
async function snapshotHighlightIds(client: InstagramClient): Promise<Set<string>> {
  try {
    const res = await ep.highlights(client, client.uid)
    const tray = (res.data as { tray?: Array<{ id?: string | number }> } | undefined)?.tray
    if (Array.isArray(tray)) return new Set(tray.map((t) => String(t.id)))
  } catch {
    // ignore — treated as "no highlights known"
  }
  return new Set()
}

// True when the tray now contains a highlight id that wasn't present in `before`.
async function highlightAppeared(client: InstagramClient, before: Set<string>): Promise<boolean> {
  const now = await snapshotHighlightIds(client)
  for (const id of now) {
    if (!before.has(id)) return true
  }
  return false
}
