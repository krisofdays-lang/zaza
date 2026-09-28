"use server"

import { createHash } from "node:crypto"
import { db } from "@/lib/db"
import { igMedia, type IgMedia } from "@/lib/db/schema"
import { and, eq, desc, inArray, lt, count as sqlCount } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { requireUserId } from "@/lib/auth/session"
import { saveLocalMedia, deleteLocalMedia, relPathFromUrl } from "@/lib/media/storage"

function detectKind(contentType: string, name: string): "image" | "video" {
  if (contentType.startsWith("video/")) return "video"
  if (contentType.startsWith("image/")) return "image"
  return /\.(mp4|mov|webm|m4v|avi)$/i.test(name) ? "video" : "image"
}

export async function getMedia(): Promise<IgMedia[]> {
  const userId = await requireUserId()
  return db.select().from(igMedia).where(eq(igMedia.userId, userId)).orderBy(desc(igMedia.createdAt))
}

// Paginated media for the storage page — only the columns the grid needs, in
// pages of `limit` rows. The initial page loads server-side; further pages are
// fetched by the client via loadMoreMedia(). This keeps the RSC payload small
// even with thousands of files in the library.
const mediaDisplayColumns = {
  id: igMedia.id,
  name: igMedia.name,
  kind: igMedia.kind,
  blobUrl: igMedia.blobUrl,
  contentType: igMedia.contentType,
  size: igMedia.size,
  isUnique: igMedia.isUnique,
  label: igMedia.label,
  usedByAccountId: igMedia.usedByAccountId,
  createdAt: igMedia.createdAt,
}

export type DisplayMedia = {
  id: number
  name: string
  kind: string
  blobUrl: string
  contentType: string
  size: number
  isUnique: boolean
  label: string
  usedByAccountId: number | null
  createdAt: Date
}

export async function getMediaPaged(limit = 48): Promise<{ items: DisplayMedia[]; total: number }> {
  const userId = await requireUserId()
  const [items, [{ value: total }]] = await Promise.all([
    db.select(mediaDisplayColumns).from(igMedia).where(eq(igMedia.userId, userId)).orderBy(desc(igMedia.createdAt)).limit(limit),
    db.select({ value: sqlCount() }).from(igMedia).where(eq(igMedia.userId, userId)),
  ])
  return { items: items as DisplayMedia[], total }
}

// Cursor-based loading: fetch the next page of media older than `beforeId`.
export async function loadMoreMedia(beforeId: number, limit = 48): Promise<DisplayMedia[]> {
  const userId = await requireUserId()
  const rows = await db
    .select(mediaDisplayColumns)
    .from(igMedia)
    .where(and(eq(igMedia.userId, userId), lt(igMedia.id, beforeId)))
    .orderBy(desc(igMedia.createdAt))
    .limit(limit)
  return rows as DisplayMedia[]
}

// Lightweight media list for pickers (workflow/publication editors) — only id,
// name, kind, blobUrl and usedByAccountId. No heavy fields, no pagination since
// pickers need the full list for search.
export type PickerMedia = Awaited<ReturnType<typeof getMediaForPicker>>[number]

export async function getMediaForPicker() {
  const userId = await requireUserId()
  return db
    .select({
      id: igMedia.id,
      name: igMedia.name,
      kind: igMedia.kind,
      blobUrl: igMedia.blobUrl,
      isUnique: igMedia.isUnique,
      usedByAccountId: igMedia.usedByAccountId,
    })
    .from(igMedia)
    .where(eq(igMedia.userId, userId))
    .orderBy(desc(igMedia.createdAt))
    .limit(500)
}

export async function uploadMedia(formData: FormData, opts?: { skipRevalidate?: boolean }) {
  const userId = await requireUserId()
  const file = formData.get("file")
  if (!(file instanceof File)) return { ok: false, error: "No file provided" }

  const sourceId = formData.get("sourceId")
  const isUnique = formData.get("isUnique") === "1"
  const label = (formData.get("label") as string | null)?.slice(0, 120) || ""
  const kind = detectKind(file.type, file.name)

  const buffer = Buffer.from(await file.arrayBuffer())
  const contentHash = createHash("sha256").update(buffer).digest("hex")

  // Deduplicate by content: if this user already has a file with identical
  // bytes, reuse that row instead of writing another copy to disk + inserting a
  // new row. This is why attaching the same reel to three Post Reel steps (or
  // re-uploading it) stores it only once. Uniqueized copies have different bytes
  // (see uniquifyMp4/uniquifyJpeg), so they get a different hash and never
  // collide with their source here. Skipped for uniqueized uploads, which must
  // stay as distinct rows.
  if (!isUnique) {
    const existing = await db
      .select()
      .from(igMedia)
      .where(and(eq(igMedia.userId, userId), eq(igMedia.contentHash, contentHash)))
      .limit(1)
    if (existing[0]) {
      return { ok: true, media: existing[0], deduped: true }
    }
  }

  // Persist the bytes to the per-user directory on disk.
  const { relPath, url } = await saveLocalMedia(userId, file.name, buffer)

  const [row] = await db
    .insert(igMedia)
    .values({
      userId,
      name: file.name,
      kind,
      blobUrl: url, // route URL: /api/media/<userId>/<filename>
      pathname: relPath, // on-disk relative path: <userId>/<filename>
      contentType: file.type || "",
      size: file.size,
      contentHash,
      isUnique,
      label,
      sourceId: sourceId ? Number(sourceId) : null,
    })
    .returning()

  if (!opts?.skipRevalidate) revalidatePath("/storage")
  return { ok: true, media: row }
}

// Update the user-editable label/note on a media item.
export async function updateMediaLabel(id: number, label: string) {
  const userId = await requireUserId()
  await db
    .update(igMedia)
    .set({ label: label.slice(0, 120) })
    .where(and(eq(igMedia.id, id), eq(igMedia.userId, userId)))
  revalidatePath("/storage")
  return { ok: true }
}

// Mark one or more media rows as "used" by a specific account. Called by the
// publishing flows after a successful post so the library can show which
// account a file belongs to. Uniqueized copies are separate rows and stay
// unmarked until they themselves are published.
export async function markMediaUsedByAccount(userId: number, accountId: number, mediaIds: number[]) {
  const ids = [...new Set(mediaIds.filter((n) => Number.isInteger(n) && n > 0))]
  if (ids.length === 0) return
  await db
    .update(igMedia)
    .set({ usedByAccountId: accountId })
    .where(and(eq(igMedia.userId, userId), inArray(igMedia.id, ids)))
}

export async function deleteMedia(id: number) {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(igMedia)
    .where(and(eq(igMedia.id, id), eq(igMedia.userId, userId)))
    .limit(1)
  const media = rows[0]
  if (!media) return { ok: false, error: "Not found" }
  // Remove the file from disk (prefer the stored relative path; fall back to
  // parsing the URL for older rows).
  const rel = media.pathname || relPathFromUrl(media.blobUrl)
  if (rel) await deleteLocalMedia(rel)
  await db.delete(igMedia).where(and(eq(igMedia.id, id), eq(igMedia.userId, userId)))
  revalidatePath("/storage")
  return { ok: true }
}
