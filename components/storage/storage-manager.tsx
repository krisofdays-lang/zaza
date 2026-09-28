"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { uploadMedia, deleteMedia, updateMediaLabel, loadMoreMedia, type DisplayMedia } from "@/app/actions/storage"
import { uniqueizeFile, compressVideo } from "@/lib/uniqueize"
import { LazyMediaThumb } from "@/components/storage/lazy-media-thumb"
import { stampIphoneMetadata } from "@/lib/media/metadata"
import { Upload, Sparkles, Trash2, Loader2, Film, ImageIcon, BadgeCheck, Minimize2, User, Play, Search, X } from "lucide-react"

type AccountOpt = { id: number; name: string }

function formatSize(bytes: number) {
  if (!bytes) return "—"
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`
  return `${bytes} B`
}

export function StorageManager({
  initialMedia,
  totalMedia = 0,
  accountNames = {},
  accounts = [],
}: {
  initialMedia: DisplayMedia[]
  totalMedia?: number
  accountNames?: Record<number, string>
  accounts?: AccountOpt[]
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState<Record<number, string>>({})
  // Media currently opened full-size in the preview lightbox (null = closed).
  const [preview, setPreview] = useState<DisplayMedia | null>(null)
  // Account filter: type to find an account, click it to show only its media.
  const [accountQuery, setAccountQuery] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filterAccountId, setFilterAccountId] = useState<number | null>(null)

  // Server-side paginated media: starts with the first page from the server,
  // additional pages are fetched via loadMoreMedia() when the user scrolls.
  const [allMedia, setAllMedia] = useState<DisplayMedia[]>(initialMedia)
  const [hasMore, setHasMore] = useState(initialMedia.length < totalMedia)
  const [loadingMore, setLoadingMore] = useState(false)

  // Sync with RSC re-renders (e.g. after upload/delete triggers revalidatePath).
  useEffect(() => {
    setAllMedia(initialMedia)
    setHasMore(initialMedia.length < totalMedia)
  }, [initialMedia, totalMedia])

  const matchingAccounts = useMemo(() => {
    const q = accountQuery.trim().toLowerCase()
    const list = q ? accounts.filter((a) => a.name.toLowerCase().includes(q)) : accounts
    return list.slice(0, 50)
  }, [accounts, accountQuery])

  // The media actually rendered — filtered to one account when a filter is set.
  const shownMedia = useMemo(
    () => (filterAccountId == null ? allMedia : allMedia.filter((m) => m.usedByAccountId === filterAccountId)),
    [allMedia, filterAccountId],
  )

  // Render the grid in chunks so a huge library never mounts thousands of DOM
  // nodes at once. A sentinel at the end of the grid grows the window as the
  // user scrolls. Combined with LazyMediaThumb, only near-visible media loads.
  const PAGE = 48
  const [visibleCount, setVisibleCount] = useState(PAGE)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Reset the window whenever the visible set changes (e.g. account filter).
  useEffect(() => {
    setVisibleCount(PAGE)
  }, [filterAccountId])

  const pagedMedia = useMemo(() => shownMedia.slice(0, visibleCount), [shownMedia, visibleCount])

  // Fetch next page from server when the sentinel scrolls into view and we've
  // exhausted the locally loaded set.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        if (visibleCount < shownMedia.length) {
          // Still have locally buffered items — just grow the render window.
          setVisibleCount((c) => Math.min(c + PAGE, shownMedia.length))
        } else if (hasMore && !loadingMore && filterAccountId == null) {
          // Exhausted local buffer — fetch the next page from the server.
          setLoadingMore(true)
          const lastId = allMedia[allMedia.length - 1]?.id
          if (lastId) {
            loadMoreMedia(lastId, PAGE).then((rows) => {
              if (rows.length === 0) {
                setHasMore(false)
              } else {
                setAllMedia((prev) => [...prev, ...rows])
                setVisibleCount((c) => c + rows.length)
                if (rows.length < PAGE) setHasMore(false)
              }
              setLoadingMore(false)
            })
          } else {
            setLoadingMore(false)
          }
        }
      },
      { rootMargin: "600px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visibleCount, shownMedia.length, hasMore, loadingMore, filterAccountId, allMedia])

  function selectAccount(a: AccountOpt) {
    setFilterAccountId(a.id)
    setAccountQuery(a.name)
    setPickerOpen(false)
  }

  function clearAccountFilter() {
    setFilterAccountId(null)
    setAccountQuery("")
    setPickerOpen(false)
  }

  function setItemBusy(id: number, label: string | null) {
    setBusy((prev) => {
      const next = { ...prev }
      if (label) next[id] = label
      else delete next[id]
      return next
    })
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    let okCount = 0
    for (const file of Array.from(files)) {
      const kind = file.type.startsWith("video/") ? "video" : "image"
      // Stamp realistic iPhone capture metadata + a US GPS location before
      // upload. Best-effort: returns the original file on any failure.
      const stamped = await stampIphoneMetadata(file, kind)
      const fd = new FormData()
      fd.append("file", stamped)
      const res = await uploadMedia(fd)
      if (res.ok) okCount++
      else toast.error(res.error || `Failed to upload ${file.name}`)
    }
    setUploading(false)
    if (inputRef.current) inputRef.current.value = ""
    if (okCount) toast.success(`Uploaded ${okCount} file${okCount > 1 ? "s" : ""}`)
    router.refresh()
  }

  async function fetchAsFile(media: DisplayMedia): Promise<File> {
    const res = await fetch(media.blobUrl)
    const blob = await res.blob()
    return new File([blob], media.name, { type: media.contentType || blob.type })
  }

  async function handleUniqueize(media: DisplayMedia) {
    try {
      setItemBusy(media.id, media.kind === "video" ? "Loading…" : "Processing…")
      const file = await fetchAsFile(media)
      const kind = media.kind === "video" ? "video" : "image"
      const unique = await uniqueizeFile(file, kind, (ratio) =>
        setItemBusy(media.id, `Encoding ${Math.round(ratio * 100)}%`),
      )
      setItemBusy(media.id, "Uploading…")
      const fd = new FormData()
      fd.append("file", unique)
      fd.append("sourceId", String(media.id))
      fd.append("isUnique", "1")
      // Uniqueized copy is a fresh, unowned file — it keeps the source label
      // for context but is NOT marked as used by any account.
      if (media.label) fd.append("label", media.label)
      const up = await uploadMedia(fd)
      if (up.ok) toast.success("Uniqueized copy saved")
      else toast.error(up.error || "Upload failed")
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Uniqueize failed")
    } finally {
      setItemBusy(media.id, null)
    }
  }

  async function handleCompress(media: DisplayMedia) {
    try {
      setItemBusy(media.id, "Loading…")
      const file = await fetchAsFile(media)
      const compressed = await compressVideo(file, (ratio) =>
        setItemBusy(media.id, `Compressing ${Math.round(ratio * 100)}%`),
      )
      // Skip if compression didn't actually shrink the file.
      if (compressed.size >= file.size) {
        toast.info("Already well compressed — no smaller copy saved")
        return
      }
      setItemBusy(media.id, "Uploading…")
      const fd = new FormData()
      fd.append("file", compressed)
      fd.append("sourceId", String(media.id))
      if (media.label) fd.append("label", media.label)
      const up = await uploadMedia(fd)
      if (up.ok) {
        const saved = Math.round((1 - compressed.size / file.size) * 100)
        toast.success(`Compressed copy saved (${saved}% smaller)`)
      } else toast.error(up.error || "Upload failed")
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Compress failed")
    } finally {
      setItemBusy(media.id, null)
    }
  }

  async function handleLabelSave(media: DisplayMedia, value: string) {
    const trimmed = value.trim()
    if (trimmed === (media.label || "")) return
    const res = await updateMediaLabel(media.id, trimmed)
    if (res.ok) router.refresh()
    else toast.error("Failed to save label")
  }

  async function handleDelete(media: DisplayMedia) {
    setItemBusy(media.id, "Deleting…")
    const res = await deleteMedia(media.id)
    setItemBusy(media.id, null)
    if (res.ok) {
      toast.success("Deleted")
      router.refresh()
    } else {
      toast.error(res.error || "Delete failed")
    }
  }

  return (
    <div className="space-y-5">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          handleFiles(e.dataTransfer.files)
        }}
        className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-10 text-center"
      >
        <div className="flex size-12 items-center justify-center rounded-full ig-gradient text-white">
          <Upload className="size-5" />
        </div>
        <div>
          <p className="font-medium">Drop files here or upload</p>
          <p className="text-sm text-muted-foreground">
            Files get iPhone capture metadata and a US location on upload.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {uploading ? "Processing…" : "Choose files"}
        </Button>
      </div>

      {/* Searchable account filter — type to find an account, click it to show
          only the media used by that account. */}
      {accounts.length > 0 && initialMedia.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={accountQuery}
              onChange={(e) => {
                setAccountQuery(e.target.value)
                setPickerOpen(true)
                if (filterAccountId != null) setFilterAccountId(null)
              }}
              onFocus={() => setPickerOpen(true)}
              onBlur={() => setTimeout(() => setPickerOpen(false), 120)}
              placeholder="Filter by account…"
              className="h-9 pl-8 pr-8"
            />
            {(accountQuery || filterAccountId != null) && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={clearAccountFilter}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear account filter"
              >
                <X className="size-4" />
              </button>
            )}
            {pickerOpen && matchingAccounts.length > 0 && (
              <ul className="absolute z-40 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
                {matchingAccounts.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectAccount(a)}
                      className={`flex w-full items-center gap-2 truncate rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary ${
                        filterAccountId === a.id ? "bg-secondary" : ""
                      }`}
                    >
                      <User className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">@{a.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {filterAccountId != null && (
            <span className="text-xs text-muted-foreground">
              Showing {shownMedia.length} file{shownMedia.length === 1 ? "" : "s"} for @
              {accountNames[filterAccountId] || `Account ${filterAccountId}`}
            </span>
          )}
        </div>
      )}

      {initialMedia.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          Your library is empty. Upload your first file to get started.
        </div>
      ) : shownMedia.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          No media used by this account yet. Clear the filter to see your whole library.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {pagedMedia.map((m) => {
            const label = busy[m.id]
            const usedBy = m.usedByAccountId ? accountNames[m.usedByAccountId] || `Account ${m.usedByAccountId}` : null
            return (
              <div key={m.id} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="relative aspect-square bg-secondary/40">
                  {/* Click the thumbnail to open the full-size preview / player. */}
                  <button
                    type="button"
                    onClick={() => setPreview(m)}
                    className="group absolute inset-0 z-10 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={m.kind === "video" ? `Play ${m.name}` : `View ${m.name}`}
                  >
                    {m.kind === "video" && (
                      <span className="flex size-11 items-center justify-center rounded-full bg-black/55 text-white opacity-80 transition group-hover:scale-105 group-hover:opacity-100">
                        <Play className="size-5 translate-x-px fill-current" />
                      </span>
                    )}
                  </button>
                  <LazyMediaThumb kind={m.kind} src={m.blobUrl} alt={m.name} />
                  <span className="pointer-events-none absolute left-2 top-2 z-20 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
                    {m.kind === "video" ? <Film className="size-3" /> : <ImageIcon className="size-3" />}
                    {m.kind}
                  </span>
                  {m.isUnique && (
                    <span className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md ig-gradient px-1.5 py-0.5 text-[11px] font-semibold text-white">
                      <BadgeCheck className="size-3" /> uniq
                    </span>
                  )}
                  {usedBy && (
                    <span
                      className="pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex items-center gap-1 truncate rounded-md bg-primary/90 px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground"
                      title={`Used by @${usedBy}`}
                    >
                      <User className="size-3 shrink-0" />
                      <span className="truncate">@{usedBy}</span>
                    </span>
                  )}
                  {label && (
                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-background/80 text-xs font-medium">
                      <Loader2 className="size-5 animate-spin text-primary" />
                      {label}
                    </div>
                  )}
                </div>
                <div className="space-y-2 p-2.5">
                  <p className="truncate text-xs font-medium" title={m.name}>
                    {m.name}
                  </p>
                  {/* Editable label/note. Saves on blur or Enter. */}
                  <Input
                    defaultValue={m.label || ""}
                    placeholder="Add a label…"
                    disabled={!!label}
                    className="h-7 text-xs"
                    onBlur={(e) => handleLabelSave(m, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) e.currentTarget.blur()
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground">{formatSize(m.size)}</p>
                  <div className="flex gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-8 flex-1 px-2 text-xs"
                      disabled={!!label}
                      onClick={() => handleUniqueize(m)}
                    >
                      <Sparkles className="size-3.5" /> Uniqueize
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-destructive hover:text-destructive"
                      disabled={!!label}
                      onClick={() => handleDelete(m)}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                  {/* Compress is video-only and sits below Uniqueize. */}
                  {m.kind === "video" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-full px-2 text-xs"
                      disabled={!!label}
                      onClick={() => handleCompress(m)}
                    >
                      <Minimize2 className="size-3.5" /> Compress
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
          {/* Sentinel: grows the render window / fetches next page as it scrolls into view. */}
          {(visibleCount < shownMedia.length || (hasMore && filterAccountId == null)) && (
            <div ref={sentinelRef} className="col-span-full flex justify-center py-6 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          )}
        </div>
      )}
      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-3xl overflow-hidden p-0 sm:max-w-3xl">
          <DialogTitle className="sr-only">{preview?.name ?? "Media preview"}</DialogTitle>
          {preview &&
            (preview.kind === "video" ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={preview.blobUrl}
                className="max-h-[80vh] w-full bg-black object-contain"
                controls
                autoPlay
                playsInline
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview.blobUrl || "/placeholder.svg"}
                alt={preview.name}
                className="max-h-[80vh] w-full bg-black object-contain"
              />
            ))}
          <p className="truncate px-4 py-3 text-sm font-medium">{preview?.name}</p>
        </DialogContent>
      </Dialog>
    </div>
  )
}
