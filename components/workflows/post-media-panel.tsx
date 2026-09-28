"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Upload, FolderOpen, ImageIcon, Loader2, X, Film, ArrowDownWideNarrow, Layers } from "lucide-react"
import { uploadMedia } from "@/app/actions/storage"
import { registerPendingFile, getPendingUrl, revokePendingFile } from "@/lib/workflows/pending-uploads"
import {
  MAX_CAROUSEL_ITEMS,
  type MediaAssignment,
  type MediaItemRef,
  type PostMediaConfig,
  type WfAccount,
  type WfMedia,
} from "@/lib/workflows/types"
import { LazyMediaThumb } from "@/components/storage/lazy-media-thumb"

/**
 * Post Media step configuration: one card per account that can hold MULTIPLE
 * photos/videos (up to 20). One item posts as a single photo/reel; two or more
 * post as a carousel via /media/configure_sidecar/. Media is referenced by
 * library id + url, so duplicating the node copies the references.
 */
export function PostMediaPanel({
  accounts,
  media: initialMedia,
  value,
  onChange,
}: {
  accounts: WfAccount[]
  media: WfMedia[]
  value: PostMediaConfig
  onChange: (next: PostMediaConfig) => void
}) {
  const [library, setLibrary] = useState<WfMedia[]>(initialMedia)
  const [pickerAccountId, setPickerAccountId] = useState<number | null>(null)
  const [uploadingFor, setUploadingFor] = useState<number | null>(null)
  // When true, the picker shows only media used by the account it was opened for.
  const [onlyThisAccount, setOnlyThisAccount] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadTargetRef = useRef<number | null>(null)
  const bunchInputRef = useRef<HTMLInputElement>(null)

  const pickerAccount = accounts.find((a) => a.id === pickerAccountId)
  const allFiltered = useMemo(
    () =>
      onlyThisAccount && pickerAccountId != null
        ? library.filter((m) => m.usedByAccountId === pickerAccountId)
        : library,
    [library, onlyThisAccount, pickerAccountId],
  )
  // Progressive rendering — only mount first batch, load more on scroll.
  const PICKER_PAGE = 40
  const [pickerLimit, setPickerLimit] = useState(PICKER_PAGE)
  const shownLibrary = useMemo(() => allFiltered.slice(0, pickerLimit), [allFiltered, pickerLimit])
  const hasMore = allFiltered.length > pickerLimit
  const scrollSentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => { setPickerLimit(PICKER_PAGE) }, [onlyThisAccount, pickerAccountId])
  const loadMore = useCallback(() => {
    setPickerLimit((n) => Math.min(n + PICKER_PAGE, allFiltered.length))
  }, [allFiltered.length])
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

  function openPicker(accountId: number) {
    setOnlyThisAccount(false)
    setPickerLimit(PICKER_PAGE)
    setPickerAccountId(accountId)
  }

  const assignedCount = useMemo(
    () => accounts.filter((acc) => (value.assignments.find((a) => a.accountId === acc.id)?.items.length ?? 0) > 0).length,
    [accounts, value.assignments],
  )

  function assignmentFor(accountId: number): MediaAssignment | undefined {
    return value.assignments.find((a) => a.accountId === accountId)
  }

  function itemsFor(accountId: number): MediaItemRef[] {
    return assignmentFor(accountId)?.items ?? []
  }

  function setAssignment(accountId: number, patch: Partial<MediaAssignment>) {
    const existing = assignmentFor(accountId)
    const next: MediaAssignment = {
      accountId,
      items: [],
      description: "",
      ...existing,
      ...patch,
    }
    const others = value.assignments.filter((a) => a.accountId !== accountId)
    onChange({ assignments: [...others, next] })
  }

  // Toggle an item in the account's ordered list (add if absent, remove if present).
  function toggleItem(accountId: number, m: WfMedia) {
    const current = itemsFor(accountId)
    const exists = current.some((it) => it.mediaId === m.id)
    if (exists) {
      setAssignment(accountId, { items: current.filter((it) => it.mediaId !== m.id) })
      return
    }
    if (current.length >= MAX_CAROUSEL_ITEMS) {
      toast.info(`A carousel can hold up to ${MAX_CAROUSEL_ITEMS} items`)
      return
    }
    setAssignment(accountId, {
      items: [...current, { mediaId: m.id, mediaUrl: m.blobUrl, mediaName: m.name, kind: m.kind }],
    })
  }

  function removeItem(accountId: number, item: MediaItemRef) {
    if (item.pendingKey) revokePendingFile(item.pendingKey)
    setAssignment(accountId, {
      items: itemsFor(accountId).filter((it) =>
        item.pendingKey ? it.pendingKey !== item.pendingKey : it.mediaId !== item.mediaId,
      ),
    })
  }

  // "Upload bunch": pick multiple photos at once; each fills one account in order
  // (file[i] -> account[i], replacing that account's items with the single
  // photo). Extra files beyond the account count are ignored; fewer files than
  // accounts leaves the remaining accounts untouched. Files are held in the
  // pending registry and uploaded to storage on run.
  function handleBunch(files: FileList | null) {
    if (!files || files.length === 0 || accounts.length === 0) return
    // Copy out of the live FileList before clearing the input, otherwise
    // resetting input.value empties `files` before we read it.
    const chosen = Array.from(files).slice(0, accounts.length)
    if (bunchInputRef.current) bunchInputRef.current.value = ""
    const others = value.assignments
    const next: MediaAssignment[] = accounts.map((acc, i) => {
      const existing = others.find((a) => a.accountId === acc.id)
      const base: MediaAssignment = existing ?? { accountId: acc.id, items: [], description: "" }
      const file = chosen[i]
      if (!file) return base
      base.items.forEach((it) => it.pendingKey && revokePendingFile(it.pendingKey))
      const key = registerPendingFile(file)
      const kind = file.type.startsWith("video") ? "video" : "image"
      const item: MediaItemRef = { mediaId: 0, mediaUrl: "", mediaName: file.name, kind, pendingKey: key }
      return { ...base, items: [item] }
    })
    onChange({ assignments: next })
    toast.success(`Attached ${chosen.length} item${chosen.length === 1 ? "" : "s"} — saved to storage on run`)
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
        const current = itemsFor(accountId)
        if (current.length >= MAX_CAROUSEL_ITEMS) {
          toast.info(`A carousel can hold up to ${MAX_CAROUSEL_ITEMS} items`)
        } else {
          setAssignment(accountId, {
            items: [...current, { mediaId: m.id, mediaUrl: m.blobUrl, mediaName: m.name, kind: m.kind }],
          })
          toast.success("Media attached")
        }
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
        <ImageIcon className="size-3.5" /> Media per account
      </p>
      <p className="text-[11px] text-muted-foreground">
        Attach one item for a single post, or 2–{MAX_CAROUSEL_ITEMS} to publish a carousel.
      </p>

      {accounts.length > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 w-full text-xs"
          onClick={() => bunchInputRef.current?.click()}
        >
          <Layers className="size-3.5" /> Upload bunch
        </Button>
      )}

      {accounts.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-center text-xs text-muted-foreground">
          No accounts available yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((acc) => {
            const items = itemsFor(acc.id)
            const uploading = uploadingFor === acc.id
            const initial = (acc.username || acc.label || "?").charAt(0).toUpperCase()
            const skipped = items.length === 0
            return (
              <li key={acc.id} className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {initial}
                  </span>
                  <span className="truncate text-sm font-medium">@{acc.username || acc.label}</span>
                  {items.length > 1 ? (
                    <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                      Carousel · {items.length}
                    </span>
                  ) : skipped ? (
                    <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Skipped
                    </span>
                  ) : null}
                </div>

                {/* Thumbnails */}
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {items.map((it, idx) => {
                    const src = it.pendingKey ? getPendingUrl(it.pendingKey) : it.mediaUrl
                    return (
                      <div
                        key={it.pendingKey ?? `${it.mediaId}-${idx}`}
                        className="relative size-14 overflow-hidden rounded-md border border-border bg-background"
                      >
                        {it.kind === "video" ? (
                          // eslint-disable-next-line jsx-a11y/media-has-caption
                          <video src={src} muted playsInline preload="metadata" className="size-full object-cover" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={src || "/placeholder.svg"} alt={it.mediaName} className="size-full object-cover" />
                        )}
                        <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 text-[9px] font-semibold text-white">
                          {idx + 1}
                        </span>
                        {it.pendingKey && (
                          <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-0.5 py-0.5 text-center text-[8px] font-medium text-white">
                            On run
                          </span>
                        )}
                        <button
                          type="button"
                          aria-label="Remove media"
                          onClick={() => removeItem(acc.id, it)}
                          className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-background/80 text-foreground"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    )
                  })}
                  {uploading && (
                    <div className="flex size-14 items-center justify-center rounded-md border border-border bg-background">
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {items.length === 0 && !uploading && (
                    <div className="flex size-14 items-center justify-center rounded-md border border-dashed border-border bg-background text-muted-foreground">
                      <ImageIcon className="size-5" />
                    </div>
                  )}
                </div>

                <div className="mt-2 flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-7 flex-1 px-2 text-xs"
                    disabled={uploading || items.length >= MAX_CAROUSEL_ITEMS}
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
                    onClick={() => openPicker(acc.id)}
                  >
                    <FolderOpen className="size-3" /> Storage
                  </Button>
                </div>

                <textarea
                  value={assignmentFor(acc.id)?.description ?? ""}
                  onChange={(e) => setAssignment(acc.id, { description: e.target.value })}
                  placeholder="Caption / description…"
                  rows={2}
                  className="mt-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-primary"
                />
              </li>
            )
          })}
        </ul>
      )}

      {accounts.length > 0 && (
        <p className={`text-[11px] ${assignedCount === 0 ? "text-destructive" : "text-muted-foreground"}`}>
          {assignedCount === 0
            ? "Attach media to at least one account."
            : `${assignedCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} will post. Accounts without media are skipped.`}
        </p>
      )}

      {/* Hidden file input shared by all cards */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <input
        ref={bunchInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleBunch(e.target.files)}
      />

      {/* Storage picker dialog (multi-select) */}
      <Dialog open={pickerAccountId !== null} onOpenChange={(o) => !o && setPickerAccountId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose media from storage</DialogTitle>
            <DialogDescription>
              {pickerAccountId != null
                ? `Tap to add or remove. ${itemsFor(pickerAccountId).length}/${MAX_CAROUSEL_ITEMS} selected — order follows the order you tap.`
                : "Pick photos or videos for this account."}
            </DialogDescription>
          </DialogHeader>
          {/* Filter: show only media used by the account this picker was opened
              for. Sort toggles the filter on; Unsort restores the whole library. */}
          {pickerAccount && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
              <span className="truncate text-xs text-muted-foreground">
                See only media from this account (@{pickerAccount.username || pickerAccount.label})
              </span>
              <Button
                type="button"
                variant={onlyThisAccount ? "default" : "secondary"}
                size="sm"
                className="h-7 shrink-0 px-3 text-xs"
                onClick={() => setOnlyThisAccount((v) => !v)}
              >
                <ArrowDownWideNarrow className="size-3" /> {onlyThisAccount ? "Unsort" : "Sort"}
              </Button>
            </div>
          )}

          {library.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <Film className="size-8" />
              <p>No media in your library yet. Upload one in Storage or use Attach.</p>
            </div>
          ) : shownLibrary.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <Film className="size-8" />
              <p>No media used by this account. Tap Unsort to see the whole library.</p>
            </div>
          ) : (
            <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {shownLibrary.map((m) => {
                const order = pickerAccountId != null ? itemsFor(pickerAccountId).findIndex((it) => it.mediaId === m.id) : -1
                const selected = order >= 0
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => pickerAccountId != null && toggleItem(pickerAccountId, m)}
                    className={`relative aspect-square overflow-hidden rounded-md border bg-black ${selected ? "border-primary ring-2 ring-primary" : "border-border"}`}
                  >
                    <LazyMediaThumb kind={m.kind} src={m.blobUrl} alt={m.name} />
                    <span className="pointer-events-none absolute inset-x-0 top-0 truncate bg-gradient-to-b from-black/75 to-transparent px-1.5 py-1 text-left text-[10px] font-medium text-white">
                      {m.name}
                    </span>
                    {selected && (
                      <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                        {order + 1}
                      </span>
                    )}
                  </button>
                )
              })}
              {hasMore && <div ref={scrollSentinelRef} className="col-span-full flex items-center justify-center py-3 text-xs text-muted-foreground">Loading more…</div>}
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={() => setPickerAccountId(null)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
