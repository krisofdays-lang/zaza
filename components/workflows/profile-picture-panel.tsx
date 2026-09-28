"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Upload, FolderOpen, ImageIcon, Loader2, X, Check } from "lucide-react"
import { uploadMedia } from "@/app/actions/storage"
import type { ProfilePictureConfig, PfpAssignment, WfAccount, WfMedia } from "@/lib/workflows/types"
import { LazyMediaThumb } from "@/components/storage/lazy-media-thumb"

/**
 * Profile Picture step configuration: one mini-card per account so you can
 * attach a different image (uploaded or picked from the library) for each. Like
 * Post Reel, but images only and without a caption. Media is referenced by
 * library id, so duplicating the node copies the reference.
 */
export function ProfilePicturePanel({
  accounts,
  media: initialMedia,
  value,
  onChange,
}: {
  accounts: WfAccount[]
  media: WfMedia[]
  value: ProfilePictureConfig
  onChange: (next: ProfilePictureConfig) => void
}) {
  const [library, setLibrary] = useState<WfMedia[]>(initialMedia)
  const [pickerAccountId, setPickerAccountId] = useState<number | null>(null)
  const [uploadingFor, setUploadingFor] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadTargetRef = useRef<number | null>(null)

  const images = useMemo(() => library.filter((m) => m.kind === "image"), [library])
  // Progressive rendering for large libraries.
  const PICKER_PAGE = 40
  const [pickerLimit, setPickerLimit] = useState(PICKER_PAGE)
  const shownImages = useMemo(() => images.slice(0, pickerLimit), [images, pickerLimit])
  const hasMore = images.length > pickerLimit
  const scrollSentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setPickerLimit(PICKER_PAGE) }, [pickerAccountId])
  const loadMore = useCallback(() => {
    setPickerLimit((n) => Math.min(n + PICKER_PAGE, images.length))
  }, [images.length])
  useEffect(() => {
    const el = scrollSentinelRef.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMore() },
      { rootMargin: "200px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadMore])

  const assignedCount = useMemo(
    () => accounts.filter((acc) => value.assignments.find((a) => a.accountId === acc.id)?.mediaId).length,
    [accounts, value.assignments],
  )

  function assignmentFor(accountId: number): PfpAssignment | undefined {
    return value.assignments.find((a) => a.accountId === accountId)
  }

  function setAssignment(accountId: number, patch: Partial<PfpAssignment>) {
    const existing = assignmentFor(accountId)
    const next: PfpAssignment = {
      accountId,
      mediaId: null,
      mediaUrl: null,
      mediaName: null,
      ...existing,
      ...patch,
    }
    const others = value.assignments.filter((a) => a.accountId !== accountId)
    onChange({ assignments: [...others, next] })
  }

  function pickFromLibrary(accountId: number, m: WfMedia) {
    setAssignment(accountId, { mediaId: m.id, mediaUrl: m.blobUrl, mediaName: m.name })
    setPickerAccountId(null)
  }

  function clearImage(accountId: number) {
    setAssignment(accountId, { mediaId: null, mediaUrl: null, mediaName: null })
  }

  function openFilePicker(accountId: number) {
    uploadTargetRef.current = accountId
    fileInputRef.current?.click()
  }

  async function handleFile(file: File | undefined) {
    const accountId = uploadTargetRef.current
    if (!file || accountId == null) return
    if (fileInputRef.current) fileInputRef.current.value = ""
    setUploadingFor(accountId)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await uploadMedia(fd)
      if (res.ok && res.media) {
        const m: WfMedia = {
          id: res.media.id,
          name: res.media.name,
          kind: res.media.kind,
          blobUrl: res.media.blobUrl,
        }
        setLibrary((prev) => [m, ...prev])
        setAssignment(accountId, { mediaId: m.id, mediaUrl: m.blobUrl, mediaName: m.name })
        toast.success("Picture attached")
      } else {
        toast.error(res.error || "Upload failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploadingFor(null)
    }
  }

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <ImageIcon className="size-3.5" /> Picture per account
      </p>

      {accounts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-center text-xs text-muted-foreground">
          No accounts available yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((acc) => {
            const a = assignmentFor(acc.id)
            const uploading = uploadingFor === acc.id
            const initial = (acc.username || acc.label || "?").charAt(0).toUpperCase()
            const skipped = !a?.mediaId
            return (
              <li key={acc.id} className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {initial}
                  </span>
                  <span className="truncate text-sm font-medium">@{acc.username || acc.label}</span>
                  {skipped && (
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Skipped
                    </span>
                  )}
                </div>

                <div className="mt-2.5 flex items-center gap-2.5">
                  {/* Square avatar preview / placeholder */}
                  <div className="relative size-16 shrink-0 overflow-hidden rounded-full border border-border bg-background">
                    {a?.mediaUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={a.mediaUrl || "/placeholder.svg"}
                          alt={a.mediaName ?? "Profile picture"}
                          className="size-full object-cover"
                        />
                        <button
                          type="button"
                          aria-label="Remove picture"
                          onClick={() => clearImage(acc.id)}
                          className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background/80 text-foreground"
                        >
                          <X className="size-3" />
                        </button>
                      </>
                    ) : uploading ? (
                      <div className="flex size-full items-center justify-center">
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <div className="flex size-full items-center justify-center text-muted-foreground">
                        <ImageIcon className="size-5" />
                      </div>
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 gap-1.5">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 flex-1 px-2 text-xs"
                      disabled={uploading}
                      onClick={() => openFilePicker(acc.id)}
                    >
                      <Upload className="size-3" /> Attach
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 flex-1 px-2 text-xs"
                      disabled={uploading}
                      onClick={() => setPickerAccountId(acc.id)}
                    >
                      <FolderOpen className="size-3" /> Storage
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {accounts.length > 0 && (
        <p className={`text-[11px] ${assignedCount === 0 ? "text-destructive" : "text-muted-foreground"}`}>
          {assignedCount === 0
            ? "Select a picture for at least one account."
            : `${assignedCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} will update. Accounts without a picture are skipped.`}
        </p>
      )}

      {/* Hidden file input shared by all cards */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {/* Storage picker dialog */}
      <Dialog open={pickerAccountId !== null} onOpenChange={(o) => !o && setPickerAccountId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a picture from storage</DialogTitle>
            <DialogDescription>Pick an image from your media library to attach.</DialogDescription>
          </DialogHeader>
          {images.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <ImageIcon className="size-8" />
              <p>No images in your library yet. Upload one in Storage or use Attach.</p>
            </div>
          ) : (
            <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {shownImages.map((img) => {
                const active = pickerAccountId != null && assignmentFor(pickerAccountId)?.mediaId === img.id
                return (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() => pickerAccountId != null && pickFromLibrary(pickerAccountId, img)}
                    className="relative aspect-square overflow-hidden rounded-md border border-border bg-muted"
                  >
                    <LazyMediaThumb kind="image" src={img.blobUrl} alt={img.name} />
                    {active && (
                      <span className="absolute inset-0 flex items-center justify-center bg-primary/35">
                        <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="size-3.5" />
                        </span>
                      </span>
                    )}
                  </button>
                )
              })}
              {hasMore && <div ref={scrollSentinelRef} className="col-span-full flex items-center justify-center py-3 text-xs text-muted-foreground">Loading more…</div>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
