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
import {
  Upload,
  FolderOpen,
  Film,
  Loader2,
  X,
  Check,
  ArrowDownWideNarrow,
  Layers,
  Type,
  Plus,
  Trash2,
  Search,
} from "lucide-react"
import { uploadMedia } from "@/app/actions/storage"
import { startBunchUpload, isNodeUploading, getNodeUploadProgress, subscribe as subscribeBgUploads } from "@/lib/workflows/bg-uploads"
import type { PostReelConfig, ReelAssignment, WfAccount, WfMedia } from "@/lib/workflows/types"
import { LazyMediaThumb } from "@/components/storage/lazy-media-thumb"

/**
 * Post Reel step configuration: one mini-card per account so you can attach a
 * different reel (uploaded or picked from the library) and caption for each.
 * Media is referenced by library id, so duplicating the node copies the file.
 */
export function PostReelPanel({
  nodeId,
  accounts,
  media: initialMedia,
  value,
  onChange,
}: {
  nodeId: string
  accounts: WfAccount[]
  media: WfMedia[]
  value: PostReelConfig
  onChange: (next: PostReelConfig) => void
}) {
  // Local copy of the library so freshly uploaded files appear in the picker.
  const [library, setLibrary] = useState<WfMedia[]>(initialMedia)
  const [pickerAccountId, setPickerAccountId] = useState<number | null>(null)
  const [uploadingFor, setUploadingFor] = useState<number | null>(null)

  const [, bgTick] = useState(0)
  useEffect(() => subscribeBgUploads(() => bgTick((n) => n + 1)), [])
  const bunchUploading = isNodeUploading(nodeId)
  const bunchProgress = getNodeUploadProgress(nodeId)
  // When true, the picker shows only media used by the account it was opened for.
  const [onlyThisAccount, setOnlyThisAccount] = useState(false)
  // "Add captions": collect several captions, then spread them randomly across
  // every account that has a reel attached.
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const [captionDrafts, setCaptionDrafts] = useState<string[]>([""])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadTargetRef = useRef<number | null>(null)
  const bunchInputRef = useRef<HTMLInputElement>(null)

  const videos = useMemo(() => library.filter((m) => m.kind === "video"), [library])
  const pickerAccount = accounts.find((a) => a.id === pickerAccountId)
  const [pickerSearch, setPickerSearch] = useState("")
  const filteredVideos = useMemo(() => {
    let list = onlyThisAccount && pickerAccountId != null
      ? videos.filter((v) => v.usedByAccountId === pickerAccountId)
      : videos
    if (pickerSearch.trim()) {
      const q = pickerSearch.trim().toLowerCase()
      list = list.filter((v) => v.name.toLowerCase().includes(q))
    }
    return list
  }, [videos, onlyThisAccount, pickerAccountId, pickerSearch])
  // Progressive rendering: only mount the first PAGE_SIZE cells, then load more
  // as the user scrolls down. This prevents hundreds of DOM nodes + network
  // requests from being created at once, which is what caused the grid to
  // freeze and show garbled output with large libraries.
  const PICKER_PAGE = 40
  const [pickerLimit, setPickerLimit] = useState(PICKER_PAGE)
  const shownVideos = useMemo(() => filteredVideos.slice(0, pickerLimit), [filteredVideos, pickerLimit])
  const hasMore = filteredVideos.length > pickerLimit
  const scrollSentinelRef = useRef<HTMLDivElement>(null)
  // Reset limit when filter changes or picker opens.
  useEffect(() => { setPickerLimit(PICKER_PAGE) }, [onlyThisAccount, pickerAccountId, pickerSearch])
  // Infinite scroll: observe a sentinel div at the bottom of the grid.
  const loadMore = useCallback(() => {
    setPickerLimit((n) => Math.min(n + PICKER_PAGE, filteredVideos.length))
  }, [filteredVideos.length])
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
    setPickerSearch("")
    setPickerLimit(PICKER_PAGE)
    setPickerAccountId(accountId)
  }

  // Accounts without a reel are skipped at run time; at least one is required.
  const assignedCount = useMemo(
    () =>
      accounts.filter((acc) => {
        const a = value.assignments.find((x) => x.accountId === acc.id)
        return Boolean(a?.mediaId)
      }).length,
    [accounts, value.assignments],
  )

  function assignmentFor(accountId: number): ReelAssignment | undefined {
    return value.assignments.find((a) => a.accountId === accountId)
  }

  function setAssignment(accountId: number, patch: Partial<ReelAssignment>) {
    const existing = assignmentFor(accountId)
    const next: ReelAssignment = {
      accountId,
      mediaId: null,
      mediaUrl: null,
      mediaName: null,
      description: "",
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

  function clearReel(accountId: number) {
    setAssignment(accountId, { mediaId: null, mediaUrl: null, mediaName: null })
  }

  function handleBunch(files: FileList | null) {
    if (!files || files.length === 0 || accounts.length === 0) return
    const chosen = Array.from(files).slice(0, accounts.length)
    if (bunchInputRef.current) bunchInputRef.current.value = ""

    const pairs = chosen.map((file, i) => ({ accountId: accounts[i].id, file }))
    const snap = value

    startBunchUpload(nodeId, pairs, (fd) => uploadMedia(fd), (results) => {
      const fresh: WfMedia[] = []
      for (const r of results) {
        if (r.media && !library.some((x) => x.id === r.media!.id)) {
          fresh.push({ id: r.media.id, name: r.media.name, kind: r.media.kind, blobUrl: r.media.blobUrl })
        }
      }
      if (fresh.length > 0) setLibrary((prev) => [...fresh, ...prev])

      const others = snap.assignments
      const next: ReelAssignment[] = accounts.map((acc) => {
        const existing = others.find((a) => a.accountId === acc.id)
        const base: ReelAssignment = existing ?? {
          accountId: acc.id,
          mediaId: null,
          mediaUrl: null,
          mediaName: null,
          description: "",
        }
        const r = results.find((x) => x.accountId === acc.id)
        if (!r?.media) return base
        return { ...base, mediaId: r.media.id, mediaUrl: r.media.blobUrl, mediaName: r.media.name }
      })
      onChange({ assignments: next })

      const okCount = results.filter((r) => r.media).length
      const failed = pairs.length - okCount
      if (okCount > 0) {
        toast.success(`Attached ${okCount} reel${okCount === 1 ? "" : "s"} to storage${failed > 0 ? ` (${failed} failed)` : ""}`)
      } else {
        toast.error("Upload failed")
      }
    })
  }

  function openFilePicker(accountId: number) {
    uploadTargetRef.current = accountId
    fileInputRef.current?.click()
  }

  function openCaptions() {
    setCaptionDrafts([""])
    setCaptionsOpen(true)
  }

  // Spread the entered captions randomly across every account that has a reel
  // attached (uploaded or pending). Accounts without a reel are left untouched.
  function applyCaptions() {
    const caps = captionDrafts.map((c) => c.trim()).filter(Boolean)
    if (caps.length === 0) {
      toast.error("Add at least one caption")
      return
    }
    const attachedIds = accounts
      .filter((acc) => {
        const a = assignmentFor(acc.id)
        return Boolean(a?.mediaId)
      })
      .map((acc) => acc.id)
    if (attachedIds.length === 0) {
      toast.error("Attach a reel to at least one account first")
      return
    }
    const others = value.assignments
    const next: ReelAssignment[] = accounts.map((acc) => {
      const existing = others.find((a) => a.accountId === acc.id)
      const base: ReelAssignment = existing ?? {
        accountId: acc.id,
        mediaId: null,
        mediaUrl: null,
        mediaName: null,
        description: "",
      }
      if (!attachedIds.includes(acc.id)) return base
      const cap = caps[Math.floor(Math.random() * caps.length)]
      return { ...base, description: cap }
    })
    onChange({ assignments: next })
    setCaptionsOpen(false)
    toast.success(`Captions added to ${attachedIds.length} reel${attachedIds.length === 1 ? "" : "s"}`)
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
        toast.success("Reel attached")
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
        <Film className="size-3.5" /> Reel per account
      </p>

      {accounts.length > 0 && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 w-full text-xs"
            disabled={bunchUploading}
            onClick={() => bunchInputRef.current?.click()}
          >
            {bunchUploading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Uploading{bunchProgress ? ` ${bunchProgress.done}/${bunchProgress.total}` : ""}…
              </>
            ) : (
              <>
                <Layers className="size-3.5" /> Upload bunch
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 w-full text-xs"
            onClick={openCaptions}
          >
            <Type className="size-3.5" /> Add captions
          </Button>
        </div>
      )}

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
            const previewUrl = a?.mediaUrl
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

                <div className="mt-2.5 flex flex-col gap-2.5">
                  {/* Reel preview / placeholder */}
                  <div className="relative mx-auto aspect-[9/16] w-20 shrink-0 overflow-hidden rounded-md border border-border bg-background">
                    {previewUrl ? (
                      <>
                        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                        <video
                          src={previewUrl}
                          muted
                          playsInline
                          preload="metadata"
                          className="size-full object-cover"
                        />
                        <button
                          type="button"
                          aria-label="Remove reel"
                          onClick={() => clearReel(acc.id)}
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
                        <Film className="size-5" />
                      </div>
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex gap-1.5">
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
                        onClick={() => openPicker(acc.id)}
                      >
                        <FolderOpen className="size-3" /> Storage
                      </Button>
                    </div>
                    <textarea
                      value={a?.description ?? ""}
                      onChange={(e) => setAssignment(acc.id, { description: e.target.value })}
                      placeholder="Caption / description…"
                      rows={2}
                      className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-primary"
                    />
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {accounts.length > 0 && (
        <p
          className={`text-[11px] ${assignedCount === 0 ? "text-destructive" : "text-muted-foreground"}`}
        >
          {assignedCount === 0
            ? "Select a reel for at least one account."
            : `${assignedCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} will post. Accounts without a reel are skipped.`}
        </p>
      )}

      {/* Hidden file input shared by all cards */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <input
        ref={bunchInputRef}
        type="file"
        accept="video/*"
        multiple
        className="hidden"
        onChange={(e) => handleBunch(e.target.files)}
      />

      {/* Storage picker dialog */}
      <Dialog open={pickerAccountId !== null} onOpenChange={(o) => !o && setPickerAccountId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a reel from storage</DialogTitle>
            <DialogDescription>Pick a video from your media library to attach.</DialogDescription>
          </DialogHeader>

          {/* Filter: show only reels used by the account this picker was opened
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

          {/* Search bar for large libraries */}
          {videos.length > 20 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder={`Search ${videos.length} videos…`}
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
          )}

          {videos.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <Film className="size-8" />
              <p>No videos in your library yet. Upload one in Storage or use Attach.</p>
            </div>
          ) : shownVideos.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <Film className="size-8" />
              <p>{pickerSearch ? "No videos match your search." : "No reels used by this account. Tap Unsort to see the whole library."}</p>
            </div>
          ) : (
            <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {shownVideos.map((v) => {
                const active = pickerAccountId != null && assignmentFor(pickerAccountId)?.mediaId === v.id
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => pickerAccountId != null && pickFromLibrary(pickerAccountId, v)}
                    className="relative aspect-[9/16] overflow-hidden rounded-md border border-border bg-black"
                  >
                    <LazyMediaThumb kind="video" src={v.blobUrl} alt={v.name} />
                    <span className="pointer-events-none absolute inset-x-0 top-0 truncate bg-gradient-to-b from-black/75 to-transparent px-1.5 py-1 text-left text-[10px] font-medium text-white">
                      {v.name}
                    </span>
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
              {/* Infinite scroll sentinel */}
              {hasMore && <div ref={scrollSentinelRef} className="col-span-full flex items-center justify-center py-3 text-xs text-muted-foreground">Loading more…</div>}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add captions dialog: enter several captions, spread them randomly
          across every account that has a reel attached. */}
      <Dialog open={captionsOpen} onOpenChange={setCaptionsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add captions</DialogTitle>
            <DialogDescription>
              Add one or more captions. They&apos;ll be spread randomly across every account that has a reel attached.
            </DialogDescription>
          </DialogHeader>

          <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
            {captionDrafts.map((draft, i) => (
              <div key={i} className="flex items-start gap-2">
                <textarea
                  value={draft}
                  onChange={(e) =>
                    setCaptionDrafts((prev) => prev.map((d, idx) => (idx === i ? e.target.value : d)))
                  }
                  placeholder={`Caption ${i + 1}…`}
                  rows={3}
                  className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-primary"
                />
                {captionDrafts.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove caption"
                    className="mt-0.5 size-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setCaptionDrafts((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 w-full text-xs"
            onClick={() => setCaptionDrafts((prev) => [...prev, ""])}
          >
            <Plus className="size-3.5" /> Add another caption
          </Button>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCaptionsOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={applyCaptions}>
              Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
