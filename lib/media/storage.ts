import "server-only"
import { promises as fs } from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Local filesystem media storage (self-hosted friendly).
//
// Files live under MEDIA_ROOT, partitioned by the OWNING user's internal id:
//
//   <MEDIA_ROOT>/<userId>/<filename>
//
// and are served back through the authenticated route at /api/media/<userId>/
// <filename> (see app/api/media/[...path]/route.ts). We intentionally key the
// directory by the numeric userId — NOT the license key — because the license
// key is the login credential and must never appear in image URLs that show up
// in the browser's network tab, logs, or referrers.
//
// MEDIA_ROOT defaults to ./.media-store for local dev; in Docker it is mounted
// to a persistent volume so uploads survive container rebuilds.
// ---------------------------------------------------------------------------

export const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join(process.cwd(), ".media-store")

// Strip anything that could escape the per-user directory.
function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file"
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "file"
}

// Build a unique, collision-resistant filename while preserving the extension.
export function buildFilename(originalName: string): string {
  const clean = safeName(originalName)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return `${stamp}-${clean}`
}

// The relative path stored in ig_media.pathname: "<userId>/<filename>".
export function relPathFor(userId: number, filename: string): string {
  return `${userId}/${safeName(filename)}`
}

// The browser/runner-facing URL stored in ig_media.blobUrl.
export function mediaUrlFor(relPath: string): string {
  return `/api/media/${relPath}`
}

// Absolute on-disk path for a relative "<userId>/<filename>". Guards against
// path traversal by confirming the resolved path stays inside MEDIA_ROOT.
export function absPathFor(relPath: string): string {
  const abs = path.resolve(MEDIA_ROOT, relPath)
  const root = path.resolve(MEDIA_ROOT)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("invalid media path")
  }
  return abs
}

// Write an uploaded file to disk; returns the relative path + public URL.
export async function saveLocalMedia(
  userId: number,
  originalName: string,
  data: Buffer,
): Promise<{ relPath: string; url: string }> {
  const filename = buildFilename(originalName)
  const relPath = relPathFor(userId, filename)
  const abs = absPathFor(relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, data)
  return { relPath, url: mediaUrlFor(relPath) }
}

// Read a stored file's bytes from its relative path.
export async function readLocalMedia(relPath: string): Promise<Buffer> {
  return fs.readFile(absPathFor(relPath))
}

// Best-effort delete; ignores a missing file.
export async function deleteLocalMedia(relPath: string): Promise<void> {
  try {
    await fs.unlink(absPathFor(relPath))
  } catch {
    // already gone
  }
}

// Extract the "<userId>/<filename>" relative path from a stored media URL.
// Returns null for legacy absolute (http) blob URLs.
export function relPathFromUrl(url: string): string | null {
  const m = url.match(/^\/api\/media\/(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

// Resolve any stored media reference to bytes: local route URLs are read from
// disk, legacy absolute blob URLs are fetched over HTTP. Used by the posting
// runners, which are detached and cannot build an absolute origin URL.
export async function loadMediaBuffer(urlOrRelPath: string): Promise<Buffer> {
  const rel = urlOrRelPath.startsWith("/api/media/")
    ? relPathFromUrl(urlOrRelPath)
    : urlOrRelPath.startsWith("http")
      ? null
      : urlOrRelPath
  if (rel) return readLocalMedia(rel)
  // Legacy absolute blob URL — fetch over HTTP.
  const res = await fetch(urlOrRelPath)
  if (!res.ok) throw new Error(`fetch_${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// Content-type guess from a filename extension (route fallback).
export function contentTypeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || ""
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    m4v: "video/x-m4v",
  }
  return map[ext] || "application/octet-stream"
}
