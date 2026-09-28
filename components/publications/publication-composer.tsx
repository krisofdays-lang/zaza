"use client"

import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Film, ImageIcon, BookImage, Clapperboard, Sparkles, Search, Loader2, Plus, Trash2, Link2, Send, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { publishNow, type PubType, type Assignment, type LinkSticker } from "@/app/actions/publications"
import { uploadMedia } from "@/app/actions/storage"
import { LinkStickerEditor, LinkStickerPill, type LinkStickerValue } from "@/components/publications/link-sticker-editor"
import { ConcurrencyControl, clampConcurrency } from "@/components/shared/concurrency-control"
import type { DisplayAccount } from "@/app/actions/accounts"
import type { PickerMedia } from "@/app/actions/storage"
import { LazyMediaThumb } from "@/components/storage/lazy-media-thumb"

type GroupLite = { id: number; name: string; accountIds: number[] }

// Single-media preview that can overlay a draggable link-sticker pill directly
// on the media (used by Story/Highlight), instead of a duplicate preview box.
function SingleMediaPreview({
  media,
  onAdd,
  onClear,
  pill,
}: {
  media: PickerMedia | undefined
  onAdd: () => void
  onClear: () => void
  pill?: { value: LinkStickerValue; onChange: (next: LinkStickerValue) => void } | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className="relative aspect-[4/5] overflow-hidden rounded-lg bg-secondary">
      {media ? (
        media.kind === "video" ? (
          <video src={media.blobUrl} className="size-full object-cover" muted playsInline />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.blobUrl || "/placeholder.svg"} alt={media.name} className="size-full object-cover" />
        )
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <ImageIcon className="size-8" />
        </div>
      )}
      <button
        onClick={onAdd}
        className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-full ig-gradient px-3 py-1.5 text-xs font-semibold text-primary-foreground"
      >
        <Plus className="size-3.5" /> {media ? "Change" : "Add Media"}
      </button>
      {media && (
        <button
          onClick={onClear}
          className="absolute bottom-2 right-2 z-20 rounded-full bg-destructive/90 p-1.5 text-white"
          aria-label="Remove media"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
      {pill && <LinkStickerPill value={pill.value} onChange={pill.onChange} containerRef={ref} />}
    </div>
  )
}

const TYPES: { id: PubType; label: string; icon: typeof Film; supported: boolean }[] = [
  { id: "reel", label: "Reels", icon: Film, supported: true },
  { id: "post", label: "Post / Carousel", icon: BookImage, supported: true },
  { id: "story", label: "Story", icon: Clapperboard, supported: true },
  { id: "highlight", label: "Highlight", icon: Sparkles, supported: true },
]

export function PublicationComposer({
  accounts,
  groups,
  media,
}: {
  accounts: DisplayAccount[]
  groups: GroupLite[]
  media: PickerMedia[]
}) {
  const [type, setType] = useState<PubType>("reel")
  const [search, setSearch] = useState("")
  const [groupId, setGroupId] = useState<number | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  // Media uploaded inline during this session (added on top of storage media).
  const [extraMedia, setExtraMedia] = useState<PickerMedia[]>([])
  const [uploading, setUploading] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  // accountId -> ordered list of media ids (1 = single post/reel, 2+ = carousel)
  const [assign, setAssign] = useState<Record<number, number[]>>({})
  const MAX_CAROUSEL = 20
  // accountId -> caption (each media card has its own caption)
  const [captions, setCaptions] = useState<Record<number, string>>({})
  // accountId -> link sticker (each story card has its own settings)
  const [links, setLinks] = useState<Record<number, LinkSticker>>({})
  // accountIds that have the link sticker enabled (off by default).
  const [linkEnabled, setLinkEnabled] = useState<Record<number, boolean>>({})
  // Highlight title (shared across accounts) when publishing a highlight.
  const [highlightName, setHighlightName] = useState("")
  const [picking, setPicking] = useState<number | null>(null)
  const [concurrency, setConcurrency] = useState(1)
  const [publishing, setPublishing] = useState(false)

  const captionOf = (id: number) => captions[id] ?? ""
  const linkOf = (id: number): LinkSticker => links[id] ?? { url: "", text: "", rotation: 0, size: 100, x: 0.5, y: 0.76 }
  function setCaptionFor(id: number, value: string) {
    setCaptions((prev) => ({ ...prev, [id]: value }))
  }
  function setLinkFor(id: number, value: LinkSticker) {
    setLinks((prev) => ({ ...prev, [id]: value }))
  }
  function toggleLink(id: number, on: boolean) {
    setLinkEnabled((prev) => ({ ...prev, [id]: on }))
    if (on && !links[id]) setLinkFor(id, { url: "", text: "", rotation: 0, size: 100, x: 0.5, y: 0.76 })
  }

  const handleOf = (a: DisplayAccount) => a.username || a.label || `Account ${a.id}`

  // Storage media plus anything uploaded inline this session (newest first).
  const allMedia = useMemo(() => [...extraMedia, ...media], [extraMedia, media])

  // Upload a file straight from the picker and assign it to the target account.
  async function handleUploadFile(files: FileList | null) {
    if (!files || files.length === 0 || picking == null) return
    const accountId = picking
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", files[0])
      const res = await uploadMedia(fd)
      if (res.ok && res.media) {
        setExtraMedia((prev) => [res.media as PickerMedia, ...prev])
        addMedia(accountId, res.media.id)
        toast.success("File uploaded and attached")
      } else {
        toast.error(res.error || "Upload failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
      if (uploadInputRef.current) uploadInputRef.current.value = ""
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return accounts.filter((a) => (q ? handleOf(a).toLowerCase().includes(q) : true))
  }, [accounts, search])

  function toggle(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function applyGroup(id: number | null) {
    setGroupId(id)
    if (id == null) return
    const g = groups.find((x) => x.id === id)
    if (g) setSelected(g.accountIds)
  }

  // Auto-match: media whose name (without extension) equals the account handle.
  function autoMatch() {
    const byName = new Map<string, PickerMedia>()
    for (const m of allMedia) {
      const base = m.name.replace(/\.[^.]+$/, "").trim().toLowerCase()
      if (!byName.has(base)) byName.set(base, m)
    }
    const next: Record<number, number[]> = { ...assign }
    let matched = 0
    for (const id of selected) {
      const a = accounts.find((x) => x.id === id)
      if (!a) continue
      const hit = byName.get(handleOf(a).toLowerCase())
      if (hit) {
        next[id] = [hit.id]
        matched++
      }
    }
    setAssign(next)
    toast[matched ? "success" : "info"](matched ? `Matched ${matched} account(s) by name` : "No media names matched account handles")
  }

  const mediaIdsOf = (accountId: number): number[] => assign[accountId] ?? []

  // Add a media id. Posts can stack up to MAX_CAROUSEL items (carousel); every
  // other type holds a single item, so adding replaces and closes the picker.
  function addMedia(accountId: number, mediaId: number) {
    const multi = type === "post"
    setAssign((prev) => {
      const current = prev[accountId] ?? []
      if (!multi) return { ...prev, [accountId]: [mediaId] }
      if (current.includes(mediaId)) return { ...prev, [accountId]: current.filter((x) => x !== mediaId) }
      if (current.length >= MAX_CAROUSEL) {
        toast.info(`A carousel can hold up to ${MAX_CAROUSEL} items`)
        return prev
      }
      return { ...prev, [accountId]: [...current, mediaId] }
    })
    if (!multi) setPicking(null)
  }

  function removeMedia(accountId: number, mediaId: number) {
    setAssign((prev) => ({ ...prev, [accountId]: (prev[accountId] ?? []).filter((x) => x !== mediaId) }))
  }

  function clearMedia(accountId: number) {
    setAssign((prev) => ({ ...prev, [accountId]: [] }))
  }

  const supported = TYPES.find((t) => t.id === type)?.supported

  const isStory = type === "story" || type === "highlight"
  const isPost = type === "post"

  async function handlePublish() {
    const assignments: Assignment[] = selected
      .filter((id) => mediaIdsOf(id).length > 0)
      .map((id) => {
        const l = linkOf(id)
        const linkOn = isStory && linkEnabled[id] && l.url.trim().length > 0
        return {
          accountId: id,
          mediaIds: mediaIdsOf(id),
          caption: isStory ? undefined : captionOf(id) || undefined,
          linkSticker: linkOn ? l : null,
        }
      })

    if (!selected.length) return toast.error("Select at least one account")
    if (!supported) return toast.error(`${type} publishing is not wired to an endpoint yet — UI only`)
    if (!assignments.length) return toast.error("Attach media to at least one account")
    if (type === "highlight" && !highlightName.trim()) return toast.error("Enter a highlight name")

    setPublishing(true)
    const res = await publishNow({
      type,
      caption: "",
      groupId,
      accountIds: selected,
      assignments,
      linkSticker: null,
      highlightName: highlightName.trim() || undefined,
      concurrency: clampConcurrency(concurrency, selected.length),
    })
    setPublishing(false)

    if (res.error) return toast.error(res.error)
    const okN = res.results.filter((r) => r.ok).length
    if (okN) toast.success(`Published to ${okN}/${res.results.length} account(s)`)
    else toast.error(res.results[0]?.message || "Publish failed")
  }

  const selectedAccounts = accounts.filter((a) => selected.includes(a.id))

  return (
    <div className="flex flex-col gap-5 px-6 pb-10">
      {/* Type selector */}
      <div className="flex flex-wrap gap-2">
        {TYPES.map((t) => {
          const Icon = t.icon
          const active = type === t.id
          return (
            <button
              key={t.id}
              onClick={() => setType(t.id)}
              className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "border-transparent text-primary-foreground ig-gradient"
                  : "border-border bg-card text-foreground hover:bg-secondary/50"
              }`}
            >
              <Icon className="size-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Account selection */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="ig-gradient-text">Select Accounts</span>
            <span className="text-muted-foreground">({selected.length} selected)</span>
            {selected.length > 0 && (
              <button onClick={() => { setSelected([]); setGroupId(null) }} className="text-xs text-primary">
                Deselect all
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by username..."
                className="h-9 w-56 pl-8"
              />
            </div>
            <select
              value={groupId ?? ""}
              onChange={(e) => applyGroup(e.target.value ? Number(e.target.value) : null)}
              className="h-9 rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="">Group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        {/* Account table */}
        <div className="hidden grid-cols-[36px_minmax(0,1fr)_120px_110px] gap-3 border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:grid">
          <span />
          <span>Username</span>
          <span>Group</span>
          <span>Status</span>
        </div>
        <ul className="max-h-72 divide-y divide-border overflow-y-auto">
          {filtered.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">No accounts found</li>
          )}
          {filtered.map((a) => {
            const checked = selected.includes(a.id)
            const profile = (a.profile ?? {}) as { profile_pic_url?: string }
            const group = groups.find((g) => g.accountIds.includes(a.id))
            return (
              <li key={a.id} className="grid grid-cols-[36px_minmax(0,1fr)_120px_110px] items-center gap-3 px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(a.id)}
                  className="size-4 accent-[#d62976]"
                />
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="shrink-0 rounded-full bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5] p-[1.5px]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={profile.profile_pic_url || "/placeholder.svg"}
                      alt=""
                      crossOrigin="anonymous"
                      className="size-7 rounded-full border border-card object-cover"
                    />
                  </div>
                  <span className="truncate text-sm font-medium">@{handleOf(a)}</span>
                </div>
                <span className="hidden truncate text-xs text-muted-foreground sm:block">{group?.name ?? "—"}</span>
                <span className="hidden text-xs sm:block">
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
                    {a.status}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      {/* Per-account media assignment */}
      {selectedAccounts.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Attach media ({selectedAccounts.length} account{selectedAccounts.length > 1 ? "s" : ""})</h3>
            {selectedAccounts.length > 1 && (
              <Button variant="outline" size="sm" onClick={autoMatch}>
                Auto-match by name
              </Button>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {selectedAccounts.map((a) => {
              const items = mediaIdsOf(a.id)
                .map((id) => allMedia.find((m) => m.id === id))
                .filter((m): m is PickerMedia => Boolean(m))
              const first = items[0]
              const countLabel =
                items.length === 0 ? "no media" : items.length === 1 ? "1 media" : `${items.length} media`
              return (
                <div key={a.id} className="rounded-xl border border-border bg-card p-3">
                  <p className="mb-2 truncate text-sm font-medium">
                    {handleOf(a)}{" "}
                    <span className="text-xs text-muted-foreground">
                      ({countLabel}
                      {isPost && items.length > 1 ? " · carousel" : ""})
                    </span>
                  </p>

                  {isPost ? (
                    // Carousel-capable: a wrap of ordered thumbnails plus an add tile.
                    <div className="flex flex-wrap gap-2">
                      {items.map((m, idx) => (
                        <div
                          key={`${m.id}-${idx}`}
                          className="relative size-16 overflow-hidden rounded-md border border-border bg-secondary"
                        >
                          {m.kind === "video" ? (
                            <video src={m.blobUrl} className="size-full object-cover" muted playsInline />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={m.blobUrl || "/placeholder.svg"} alt={m.name} className="size-full object-cover" />
                          )}
                          <span className="absolute left-0.5 top-0.5 rounded bg-black/60 px-1 text-[9px] font-semibold text-white">
                            {idx + 1}
                          </span>
                          <button
                            onClick={() => removeMedia(a.id, m.id)}
                            className="absolute right-0.5 top-0.5 rounded-full bg-destructive/90 p-0.5 text-white"
                            aria-label="Remove media"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      ))}
                      {items.length < MAX_CAROUSEL && (
                        <button
                          onClick={() => setPicking(a.id)}
                          className="flex size-16 flex-col items-center justify-center gap-0.5 rounded-md border border-dashed border-border bg-secondary/40 text-muted-foreground hover:bg-secondary"
                        >
                          <Plus className="size-4" />
                          <span className="text-[9px]">Add</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    // Single-media types keep the large preview. For stories with
                    // a link sticker enabled, the draggable pill is overlaid here.
                    <SingleMediaPreview
                      media={first}
                      onAdd={() => setPicking(a.id)}
                      onClear={() => clearMedia(a.id)}
                      pill={
                        isStory && linkEnabled[a.id]
                          ? { value: linkOf(a.id), onChange: (next) => setLinkFor(a.id, next as LinkSticker) }
                          : null
                      }
                    />
                  )}

                  {/* Per-card caption (posts & reels only — stories use no caption) */}
                  {!isStory && (
                    <div className="mt-3 grid gap-1.5">
                      <Label htmlFor={`caption-${a.id}`} className="text-xs">
                        Caption
                      </Label>
                      <Textarea
                        id={`caption-${a.id}`}
                        value={captionOf(a.id)}
                        onChange={(e) => setCaptionFor(a.id, e.target.value)}
                        placeholder={`Caption for @${handleOf(a)}...`}
                        rows={2}
                      />
                    </div>
                  )}

                  {/* Per-card story link sticker — hidden until added */}
                  {isStory && (
                    <div className="mt-3 border-t border-border pt-3">
                      {linkEnabled[a.id] ? (
                        <LinkStickerEditor
                          layout="controls"
                          value={linkOf(a.id)}
                          onChange={(next) => setLinkFor(a.id, next as LinkSticker)}
                          onRemove={() => toggleLink(a.id, false)}
                          minSize={10}
                          maxSize={100}
                        />
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => toggleLink(a.id, true)}
                        >
                          <Link2 className="size-3.5" /> Add link sticker
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Publish */}
      {selectedAccounts.length > 1 && (
        <ConcurrencyControl
          value={concurrency}
          onChange={setConcurrency}
          accountCount={selectedAccounts.length}
        />
      )}
      <div className="flex flex-wrap items-end justify-end gap-3">
        {type === "highlight" && (
          <div className="mr-auto grid w-full max-w-xs gap-1.5">
            <Label htmlFor="highlight-name" className="text-xs">
              Highlight name
            </Label>
            <Input
              id="highlight-name"
              value={highlightName}
              onChange={(e) => setHighlightName(e.target.value.slice(0, 16))}
              placeholder="e.g. Links"
              maxLength={16}
            />
          </div>
        )}
        <Button onClick={handlePublish} disabled={publishing} className="ig-gradient text-primary-foreground">
          {publishing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Publish {type}
        </Button>
      </div>

      {/* Media picker dialog */}
      <Dialog open={picking != null} onOpenChange={(o) => !o && setPicking(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {isPost ? "Attach media (carousel)" : "Attach media"}
            </DialogTitle>
            {isPost && picking != null && (
              <p className="text-xs text-muted-foreground">
                Tap to add or remove. {mediaIdsOf(picking).length}/{MAX_CAROUSEL} selected — order follows the order you tap.
              </p>
            )}
          </DialogHeader>

          {/* Upload from device */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-secondary/30 px-4 py-3">
            <div className="text-sm">
              <p className="font-medium">Upload from your device</p>
              <p className="text-xs text-muted-foreground">Pick a file — it&apos;s saved to storage and attached here.</p>
            </div>
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/*,video/*"
              className="hidden"
              onChange={(e) => handleUploadFile(e.target.files)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => uploadInputRef.current?.click()}
            >
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              {uploading ? "Uploading…" : "Choose file"}
            </Button>
          </div>

          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">From storage</p>
          {allMedia.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No media in storage yet. Upload a file above or add content in the Storage section.
            </p>
          ) : (
            <div className="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {allMedia.map((m) => {
                const order = picking != null ? mediaIdsOf(picking).indexOf(m.id) : -1
                const selected = order >= 0
                return (
                <button
                  key={m.id}
                  onClick={() => picking != null && addMedia(picking, m.id)}
                  className={`group relative aspect-square overflow-hidden rounded-lg border bg-secondary ${selected ? "border-primary ring-2 ring-primary" : "border-border"}`}
                >
                  <LazyMediaThumb kind={m.kind} src={m.blobUrl} alt={m.name} />
                  {isPost && selected && (
                    <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full ig-gradient text-[10px] font-bold text-primary-foreground">
                      {order + 1}
                    </span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                    {m.name}
                  </span>
                  {m.isUnique && (
                    <span className="absolute left-1 top-1 rounded bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
                      UNIQ
                    </span>
                  )}
                </button>
                )
              })}
            </div>
          )}
          {isPost && (
            <div className="flex justify-end">
              <Button onClick={() => setPicking(null)} className="ig-gradient text-primary-foreground">
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
