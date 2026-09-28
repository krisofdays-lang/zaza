"use client"

import { useEffect, useRef, useState } from "react"

// Request the lightweight cached webp from the media route for local files.
// Legacy absolute blob URLs (http...) don't support the param, so leave them.
function thumbSrc(src: string): string {
  if (!src) return "/placeholder.svg"
  if (!src.startsWith("/api/media/")) return src
  return src.includes("?") ? `${src}&thumb=1` : `${src}?thumb=1`
}

/**
 * Lightweight media thumbnail that only fetches its source once it scrolls
 * near the viewport. This is the key to keeping the storage library and media
 * pickers responsive: without it, rendering hundreds of <video>/<img> tags at
 * once makes the browser fetch every file's bytes/metadata in parallel and the
 * tab freezes. Here nothing is requested until the cell is (nearly) visible,
 * and once loaded it stays mounted so scrolling back doesn't refetch.
 */
export function LazyMediaThumb({
  kind,
  src,
  alt,
  className = "size-full object-cover",
}: {
  kind: string
  src: string
  alt: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (visible) return
    const el = ref.current
    if (!el) return
    // Start loading a bit before the cell enters view for a smoother scroll.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: "300px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  return (
    <div ref={ref} className="size-full">
      {visible ? (
        failed ? (
          // Poster/thumb couldn't load (e.g. route returned 204 because ffmpeg
          // failed to extract a video frame). Show a static placeholder rather
          // than falling back to loading the heavy original into the grid.
          <div className="size-full bg-secondary/40" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            // `?thumb=1` asks the media route for a small cached webp — a
            // resized image, or a first-frame poster for videos. This keeps the
            // grid light even with a large, video-heavy library: no real
            // <video> elements are mounted here (they only load in the
            // full-size lightbox on click). Local route URLs support the param;
            // legacy absolute blob URLs (http...) are served as-is.
            src={thumbSrc(src)}
            alt={alt}
            className={className}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        )
      ) : (
        // Placeholder shown until the cell scrolls into view — no network cost.
        <div className="size-full animate-pulse bg-secondary/40" />
      )}
    </div>
  )
}
