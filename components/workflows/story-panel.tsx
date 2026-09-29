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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Upload, FolderOpen, ImageIcon, Loader2, Film, Shuffle, Clapperboard, ArrowDownWideNarrow, Layers } from "lucide-react"
import { uploadMedia } from "@/app/actions/storage"
import { startBunchUpload, isNodeUploading, getNodeUploadProgress, subscribe as subscribeBgUploads } from "@/lib/workflows/bg-uploads"
import { LinkStickerEditor, randomLinkPlacement } from "@/components/publications/link-sticker-editor"
import {
  emptyStoryLink,
  type StoryAssignment,
  type StoryLink,
  type WfAccount,
  type WfMedia,
} from "@/lib/workflows/types"
import { LazyMediaThumb } from "@/components/storage/lazy-media-thumb"

interface StoryPanelValue {
  assignments: StoryAssignment[]
  highlightName?: string
}

/**
 * Shared configuration panel for the Post Story and Create Highlight nodes. One
 * card per account: a single media item plus a link sticker (URL required). An
 * account is skipped when it has no media or no link URL. In "highlight" mode a
 * Highlight name field appears and the posted story is promoted to a highlight.
 */
export function StoryPanel({
  nodeId,
  mode,
  accounts,
  media: initialMedia,
  value,
  onChange,
}: {
  nodeId: string
  mode: "story" | "highlight"
  accounts: WfAccount[]
  media: WfMedia[]
  value: StoryPanelValue
  onChange: (next: StoryPanelValue) => void
}) {
  const [library, setLibrary] = useState<WfMedia[]>(initialMedia)
  const [pickerAccountId, setPickerAccountId] = useState<number | null>(null)
  const [uploadingFor, setUploadingFor] = useState<number | null>(null)
  // When true, the picker shows only media used by the account it was opened for.
  const [onlyThisAccount, setOnlyThisAccount] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadTargetRef = useRef<number | null>(null)
  const bunchInputRef = useRef<HTMLInputElement>(null)

  // Subscribe to background upload tracker so the spinner persists across
  // unmount/remount cycles (e.g. user closes and re-opens the panel).
  const [, bgTick] = useState(0)
  useEffect(() => subscribeBgUploads(() => bgTick((n) => n + 1)), [])
  const bunchUploading = isNodeUploading(nodeId)
  const bunchProgress = getNodeUploadProgress(nodeId)

  const isHighlight = mode === "highlight"

  const pickerAccount = accounts.find((a) => a.id === pickerAccountId)
  const allFiltered = useMemo(
    () =>
      onlyThisAccount && pickerAccountId != null
        ? library.filter((m) => m.usedByAccountId === pickerAccountId)
        : library,
    [library, onlyThisAccount, pickerAccountId],
  )
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

  function assignmentFor(accountId: number): StoryAssignment | undefined {
    return value.assignments.find((a) => a.accountId === accountId)
  }

  function linkFor(accountId: number): StoryLink {
    return assignmentFor(accountId)?.link ?? emptyStoryLink()
  }

  function setAssignment(accountId: number, patch: Partial<StoryAssignment>) {
    const existing = assignmentFor(accountId)
    const next: StoryAssignment = {
      accountId,
      mediaId: null,
      mediaUrl: null,
      mediaName: null,
      kind: null,
      link: emptyStoryLink(),
      ...existing,
      ...patch,
    }
    const others = value.assignments.filter((a) => a.accountId !== accountId)
    onChange({ ...value, assignments: [...others, next] })
  }

  const readyCount = useMemo(
    () =>
      accounts.filter((acc) => {
        const a = assignmentFor(acc.id)
        return Boolean(a?.mediaId) && Boolean(a?.link.url.trim())
      }).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, value.assignments],
  )

  function setMedia(accountId: number, m: WfMedia) {
    setAssignment(accountId, { mediaId: m.id, mediaUrl: m.blobUrl, mediaName: m.name, kind: m.kind })
  }

  function clearMedia(accountId: number) {
    setAssignment(accountId, { mediaId: null, mediaUrl: null, mediaName: null, kind: null })
  }

  function handleBunch(files: FileList | null) {
    if (!files || files.length === 0 || accounts.length === 0) return
    const chosen = Array.from(files).slice(0, accounts.length)
    if (bunchInputRef.current) bunchInputRef.current.value = ""

    const pairs = chosen.map((file, i) => ({ accountId: accounts[i].id, file }))
    const snap = value

    startBunchUpload(nodeId, pairs, (fd) => uploadMedia(fd), (results) => {
      const others = snap.assignments
      const next: StoryAssignment[] = accounts.map((acc) => {
        const existing = others.find((a) => a.accountId === acc.id)
        const base: StoryAssignment = existing ?? {
          accountId: acc.id,
          mediaId: null,
          mediaUrl: null,
          mediaName: null,
          kind: null,
          link: emptyStoryLink(),
        }
        const r = results.find((x) => x.accountId === acc.id)
        if (!r?.media) return base
        return { ...base, mediaId: r.media.id, mediaUrl: r.media.blobUrl, mediaName: r.media.name, kind: r.media.kind }
      })
      onChange({ ...snap, assignments: next })

      const okCount = results.filter((r) => r.media).length
      const failed = pairs.length - okCount
      if (okCount > 0) {
        toast.success(`Attached ${okCount} item${okCount === 1 ? "" : "s"} to storage${failed > 0 ? ` (${failed} failed)` : ""}`)
      } else {
        toast.error("Upload failed")
      }
    })
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
        const m: WfMedia = { id: res.media.id, name: res.media.name, kind: res.media.kind, blobUrl: res.media.blobUrl }
        setLibrary((prev) => [m, ...prev])
        setMedia(accountId, m)
        toast.success("Media attached")
      } else {
        toast.error(res.error || "Upload failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploadingFor(null)
    }
  }

  // Scatter link placement (random position + size) across every account.
  function randomizeAll() {
    const others = value.assignments
    const next = accounts.map((acc) => {
      const existing = others.find((a) => a.accountId === acc.id)
      const base: StoryAssignment = existing ?? {
        accountId: acc.id,
        mediaId: null,
        mediaUrl: null,
        mediaName: null,
        kind: null,
        link: emptyStoryLink(),
      }
      return { ...base, link: { ...base.link, ...randomLinkPlacement() } }
    })
    onChange({ ...value, assignments: next })
    toast.success("Randomized link placement")
  }

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Clapperboard className="size-3.5" /> {isHighlight ? "Highlight per account" : "Story per account"}
      </p>

      {isHighlight && (
        <div className="grid gap-1.5">
          <Label htmlFor="wf-highlight-name" className="text-xs">
            Highlight name
          </Label>
          <Input
            id="wf-highlight-name"
            value={value.highlightName ?? ""}
            onChange={(e) => onChange({ ...value, highlightName: e.target.value.slice(0, 16) })}
            placeholder="e.g. Links"
            maxLength={16}
            className="h-8 text-xs"
          />
        </div>
      )}

      {accounts.length > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-8 w-full px-2 text-xs"
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
      )}

      {accounts.length > 1 && (
        <Button type="button" variant="secondary" size="sm" className="h-7 w-full px-2 text-xs" onClick={randomizeAll}>
          <Shuffle className="size-3" /> Randomize all placements
        </Button>
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
            const skipped = !a?.mediaId || !a?.link.url.trim()
            const preview = a?.mediaUrl ? { blobUrl: a.mediaUrl, kind: a?.kind ?? "image" } : null
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

                <div className="mt-2.5 flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-7 flex-1 px-2 text-xs"
                    disabled={uploading}
                    onClick={() => openFilePicker(acc.id)}
                  >
                    {uploading ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />} Attach
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
                  {a?.mediaId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => clearMedia(acc.id)}
                    >
                      Clear
                    </Button>
                  )}
                </div>

                {/* Link sticker + draggable preview (URL required to act). */}
                <div className="mt-3 border-t border-border pt-3">
                  <LinkStickerEditor
                    value={linkFor(acc.id)}
                    onChange={(next) => setAssignment(acc.id, { link: next as StoryLink })}
                    preview={preview}
                    minSize={10}
                    maxSize={100}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {accounts.length > 0 && (
        <p className={`text-[11px] ${readyCount === 0 ? "text-destructive" : "text-muted-foreground"}`}>
          {readyCount === 0
            ? "Attach media and a link URL to at least one account."
            : `${readyCount} of ${accounts.length} account${accounts.length === 1 ? "" : "s"} will run. Accounts without media or a link URL are skipped.`}
        </p>
      )}

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
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => handleBunch(e.target.files)}
      />

      {/* Storage picker dialog (single-select) */}
      <Dialog open={pickerAccountId !== null} onOpenChange={(o) => !o && setPickerAccountId(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose media from storage</DialogTitle>
            <DialogDescription>Pick one photo or video for this story.</DialogDescription>
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
                const selected = pickerAccountId != null && assignmentFor(pickerAccountId)?.mediaId === m.id
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      if (pickerAccountId != null) setMedia(pickerAccountId, m)
                      setPickerAccountId(null)
                    }}
                    className={`relative aspect-square overflow-hidden rounded-md border bg-black ${selected ? "border-primary ring-2 ring-primary" : "border-border"}`}
                  >
                    <LazyMediaThumb kind={m.kind} src={m.blobUrl} alt={m.name} />
                    <span className="pointer-events-none absolute inset-x-0 top-0 truncate bg-gradient-to-b from-black/75 to-transparent px-1.5 py-1 text-left text-[10px] font-medium text-white">
                      {m.name}
                    </span>
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

// Unused import guard removed at build; ImageIcon kept for parity with siblings.
export const _ICON = ImageIcon
