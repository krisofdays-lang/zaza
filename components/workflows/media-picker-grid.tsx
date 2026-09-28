"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Search, Film } from "lucide-react"
import { LazyMediaThumb } from "@/components/storage/lazy-media-thumb"

export interface PickerItem {
  id: number
  name: string
  kind: string
  blobUrl: string
}

const PAGE_SIZE = 40

/**
 * Virtualized media grid for workflow storage pickers. Renders only the first
 * PAGE_SIZE items and loads more as the user scrolls, preventing the browser
 * from mounting hundreds of DOM nodes + img requests at once (which froze the
 * tab and showed garbled output with large libraries).
 *
 * Includes a search bar when total > 20 items.
 */
export function MediaPickerGrid<T extends PickerItem>({
  items,
  emptyMessage,
  emptyFilterMessage,
  renderOverlay,
  onPick,
  aspectClass = "aspect-[9/16]",
}: {
  items: T[]
  emptyMessage: string
  emptyFilterMessage: string
  renderOverlay?: (item: T) => React.ReactNode
  onPick: (item: T) => void
  aspectClass?: string
}) {
  const [search, setSearch] = useState("")
  const [limit, setLimit] = useState(PAGE_SIZE)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const q = search.trim().toLowerCase()
    return items.filter((v) => v.name.toLowerCase().includes(q))
  }, [items, search])

  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit])
  const hasMore = filtered.length > limit

  // Reset when items change (filter toggled, picker opened).
  useEffect(() => {
    setLimit(PAGE_SIZE)
  }, [items, search])

  const loadMore = useCallback(() => {
    setLimit((n) => Math.min(n + PAGE_SIZE, filtered.length))
  }, [filtered.length])

  // Infinite scroll sentinel.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMore() },
      { rootMargin: "200px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadMore])

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
        <Film className="size-8" />
        <p>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <>
      {items.length > 20 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder={`Search ${items.length} items…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      )}
      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
          <Film className="size-8" />
          <p>{emptyFilterMessage}</p>
        </div>
      ) : (
        <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {shown.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onPick(v)}
              className={`relative ${aspectClass} overflow-hidden rounded-md border border-border bg-black`}
            >
              <LazyMediaThumb kind={v.kind} src={v.blobUrl} alt={v.name} />
              <span className="pointer-events-none absolute inset-x-0 top-0 truncate bg-gradient-to-b from-black/75 to-transparent px-1.5 py-1 text-left text-[10px] font-medium text-white">
                {v.name}
              </span>
              {renderOverlay?.(v)}
            </button>
          ))}
          {hasMore && (
            <div ref={sentinelRef} className="col-span-full flex items-center justify-center py-3 text-xs text-muted-foreground">
              Loading more…
            </div>
          )}
        </div>
      )}
    </>
  )
}
