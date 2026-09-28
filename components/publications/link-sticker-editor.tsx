"use client"

import { useRef } from "react"
import { Link2, Shuffle, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

// Structural shape shared by the composer (LinkSticker) and the workflow nodes.
export interface LinkStickerValue {
  url: string
  text?: string
  rotation?: number
  size?: number
  x?: number
  y?: number
}

export const DEFAULT_LINK_STICKER: Required<Omit<LinkStickerValue, "url" | "text">> & { url: string; text: string } = {
  url: "",
  text: "",
  rotation: 0,
  size: 100,
  x: 0.5,
  y: 0.76,
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

// Randomize position (anywhere in a safe central band), keep rotation at 0 and
// pick a size in the 70–100% range — matching the genuine sticker placement.
export function randomLinkPlacement(): Pick<LinkStickerValue, "x" | "y" | "rotation" | "size"> {
  return {
    x: Number((0.2 + Math.random() * 0.6).toFixed(4)),
    y: Number((0.25 + Math.random() * 0.5).toFixed(4)),
    rotation: 0,
    size: Math.round(70 + Math.random() * 30),
  }
}

/**
 * The draggable link pill itself, positioned by normalized x/y inside a parent
 * preview. The parent passes a ref to the element that defines the drag bounds
 * (usually the media preview). Reused by the workflow node preview and overlaid
 * directly on the publications media preview so there's no duplicate preview.
 */
export function LinkStickerPill({
  value,
  onChange,
  containerRef,
}: {
  value: LinkStickerValue
  onChange: (next: LinkStickerValue) => void
  containerRef: React.RefObject<HTMLElement | null>
}) {
  const dragging = useRef(false)
  const x = value.x ?? DEFAULT_LINK_STICKER.x
  const y = value.y ?? DEFAULT_LINK_STICKER.y
  const rotation = value.rotation ?? 0
  const size = value.size ?? 100
  const label = (value.text?.trim() || "LINK").toUpperCase()

  function moveTo(clientX: number, clientY: number) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    onChange({
      ...value,
      x: Number(clamp((clientX - rect.left) / rect.width, 0.08, 0.92).toFixed(4)),
      y: Number(clamp((clientY - rect.top) / rect.height, 0.05, 0.95).toFixed(4)),
    })
  }

  return (
    <button
      type="button"
      aria-label="Drag link sticker"
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => dragging.current && moveTo(e.clientX, e.clientY)}
      onPointerUp={(e) => {
        dragging.current = false
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      className="absolute z-10 flex cursor-grab touch-none items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold text-white shadow-md active:cursor-grabbing"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${size / 100})`,
        backgroundColor: "rgb(23,23,23)",
      }}
    >
      <Link2 className="size-3" />
      <span className="max-w-[110px] truncate">{label}</span>
    </button>
  )
}

/**
 * Link-sticker control set. Two layouts:
 *  - "stacked": a 9:16 preview on top (with its own draggable pill) and the
 *    controls below — used inside the narrow workflow Edit Step panel.
 *  - "controls": controls only, no preview — used by the publications composer,
 *    which overlays {@link LinkStickerPill} on its own large media preview.
 * When `url` is empty the sticker is treated as "off".
 */
export function LinkStickerEditor({
  value,
  onChange,
  onRemove,
  preview,
  minSize = 10,
  maxSize = 150,
  layout = "stacked",
}: {
  value: LinkStickerValue
  onChange: (next: LinkStickerValue) => void
  onRemove?: () => void
  preview?: { blobUrl: string; kind: string } | null
  minSize?: number
  maxSize?: number
  layout?: "stacked" | "controls"
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rotation = value.rotation ?? 0
  const size = value.size ?? 100

  const controls = (
    <div className="grid content-start gap-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Link2 className="size-3.5" /> Link sticker
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onChange({ ...value, ...randomLinkPlacement() })}
          >
            <Shuffle className="size-3" /> Random
          </Button>
          {onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="size-3" /> Remove
            </Button>
          )}
        </div>
      </div>

      <Input
        value={value.url}
        onChange={(e) => onChange({ ...value, url: e.target.value })}
        placeholder="https://example.com"
        className="h-8 text-xs"
      />
      <Input
        value={value.text ?? ""}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        placeholder="Custom text (optional)"
        className="h-8 text-xs"
      />
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Rotation: {rotation}°
          <input
            type="range"
            min={-45}
            max={45}
            step={1}
            value={rotation}
            onChange={(e) => onChange({ ...value, rotation: Number(e.target.value) })}
            className="w-full accent-[#d62976]"
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Size: {size}%
          <input
            type="range"
            min={minSize}
            max={maxSize}
            step={1}
            value={size}
            onChange={(e) => onChange({ ...value, size: Number(e.target.value) })}
            className="w-full accent-[#d62976]"
          />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">Drag the pill on the preview to position it.</p>
    </div>
  )

  // Controls-only: the parent renders the preview + pill itself.
  if (layout === "controls") return controls

  // Stacked: preview on top, controls below — fits a narrow column.
  return (
    <div className="grid gap-3">
      <div
        ref={containerRef}
        className="relative mx-auto aspect-[9/16] w-full max-w-[150px] overflow-hidden rounded-xl border border-border bg-secondary"
      >
        {preview ? (
          preview.kind === "video" ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={preview.blobUrl} className="size-full object-cover" muted playsInline preload="metadata" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview.blobUrl || "/placeholder.svg"} alt="" className="size-full object-cover" />
          )
        ) : (
          <div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">No media</div>
        )}
        <LinkStickerPill value={value} onChange={onChange} containerRef={containerRef} />
      </div>
      {controls}
    </div>
  )
}
