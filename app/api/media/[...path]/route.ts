import { NextResponse } from "next/server"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"
import { getCurrentUser } from "@/lib/auth/session"
import { db } from "@/lib/db"
import { igMedia } from "@/lib/db/schema"
import { and, eq } from "drizzle-orm"
import { absPathFor, contentTypeFromName } from "@/lib/media/storage"

// Serves locally-stored media after verifying ownership. The first path segment
// is the owning userId; only that user (or an admin) may read it.
//
// This route streams from disk and supports HTTP Range requests. Both matter a
// lot for the storage library and media pickers: when a grid mounts dozens of
// <video>/<img> cells they all hit this same origin at once, and the browser
// only opens ~6 connections per origin. If each response streamed the WHOLE
// file (as it used to, by reading the entire buffer into memory), those 6
// sockets stayed busy for the full download and every other request to the app
// — even opening the site in a new tab — queued behind them. With Range +
// streaming, a video's `preload="metadata"` fetches just the head bytes and the
// connection frees immediately, so the tab stays responsive.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function resolveMedia(ctx: { params: Promise<{ path: string[] }> }) {
  const user = await getCurrentUser()
  if (!user) return { error: new NextResponse("Unauthorized", { status: 401 }) }

  const { path } = await ctx.params
  if (!path || path.length < 2) return { error: new NextResponse("Not found", { status: 404 }) }

  const ownerId = Number(path[0])
  if (!Number.isFinite(ownerId)) return { error: new NextResponse("Not found", { status: 404 }) }

  // Only the owner (or an admin) may read another user's media.
  if (ownerId !== user.id && !user.isAdmin) {
    return { error: new NextResponse("Forbidden", { status: 403 }) }
  }

  const relPath = path.join("/")

  let absPath: string
  try {
    absPath = absPathFor(relPath)
  } catch {
    return { error: new NextResponse("Not found", { status: 404 }) }
  }

  let size: number
  try {
    const s = await stat(absPath)
    if (!s.isFile()) return { error: new NextResponse("Not found", { status: 404 }) }
    size = s.size
  } catch {
    return { error: new NextResponse("Not found", { status: 404 }) }
  }

  // Look up the row only for the correct content-type; fall back to the
  // extension. Missing row is not fatal — the file on disk is the source of
  // truth for serving bytes.
  const rows = await db
    .select({ contentType: igMedia.contentType })
    .from(igMedia)
    .where(and(eq(igMedia.userId, ownerId), eq(igMedia.pathname, relPath)))
    .limit(1)
  const contentType = rows[0]?.contentType || contentTypeFromName(relPath)

  return { absPath, size, contentType }
}

// Cheap metadata probe: lets the browser learn size / range support without
// downloading any bytes.
export async function HEAD(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const r = await resolveMedia(ctx)
  if ("error" in r) return r.error
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Content-Type": r.contentType,
      "Content-Length": String(r.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  })
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const r = await resolveMedia(ctx)
  if ("error" in r) return r.error
  let { absPath, size, contentType } = r

  // Thumbnail mode: the storage grid + pickers request `?thumb=1` so they
  // receive a small cached webp instead of the full media. This is the fix for
  // the tab freezing when a large library is opened:
  //   - images: a resized webp instead of the multi-MB original.
  //   - videos: a first-frame webp poster (via bundled ffmpeg) instead of a
  //     real <video> element. Mounting dozens of <video> tags is the real
  //     freeze cause — the browser spins up a media decoder per element — so
  //     the grid now shows lightweight poster images and only loads actual
  //     video in the full-size lightbox.
  // Animated GIFs are left as-is (served whole).
  const wantsThumb = new URL(req.url).searchParams.get("thumb") === "1"
  const isImage = contentType.startsWith("image/") && contentType !== "image/gif"
  const isVideo = contentType.startsWith("video/")
  if (wantsThumb && (isImage || isVideo)) {
    const { path } = await ctx.params
    const relPath = path.join("/")
    const { getOrCreateThumb } = await import("@/lib/media/thumbnail")
    const thumbPath = await getOrCreateThumb(relPath, isVideo ? "video" : "image")
    if (thumbPath) {
      try {
        const s = await stat(thumbPath)
        absPath = thumbPath
        size = s.size
        contentType = "image/webp"
      } catch {
        // fall through and serve the original
      }
    } else if (isVideo) {
      // Poster couldn't be generated (e.g. ffmpeg failed). Signal "no content"
      // so the client shows its placeholder tile instead of downloading the
      // whole video into the grid.
      return new NextResponse(null, { status: 204 })
    }
  }

  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
  }

  const range = req.headers.get("range")

  // No Range header — stream the whole file (still streamed, not buffered).
  if (!range) {
    const stream = Readable.toWeb(createReadStream(absPath)) as unknown as ReadableStream
    return new NextResponse(stream, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(size) },
    })
  }

  // Parse "bytes=start-end". Either bound may be omitted.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!match) {
    return new NextResponse("Invalid range", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    })
  }

  const startRaw = match[1]
  const endRaw = match[2]
  let start: number
  let end: number

  if (startRaw === "") {
    // Suffix range: last N bytes.
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return new NextResponse("Invalid range", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
      })
    }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw === "" ? size - 1 : Number(endRaw)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new NextResponse("Range not satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    })
  }

  end = Math.min(end, size - 1)
  const chunkSize = end - start + 1
  const stream = Readable.toWeb(createReadStream(absPath, { start, end })) as unknown as ReadableStream

  return new NextResponse(stream, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    },
  })
}
