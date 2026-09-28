"use client"

import { useRef, useState } from "react"
import { Play, Eye, Heart, MessageCircle } from "lucide-react"
import type { AnalyticsReel } from "@/app/actions/analytics"
import { cn } from "@/lib/utils"

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return String(n)
}

// A vertical reel tile that plays the real video on hover and shows its view
// count. `rank` renders the medal/number badge for the top reels ranking.
export function ReelCard({ reel, rank }: { reel: AnalyticsReel; rank: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)

  function onEnter() {
    const v = videoRef.current
    if (!v || !reel.videoUrl) return
    v.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }
  function onLeave() {
    const v = videoRef.current
    if (!v) return
    v.pause()
    v.currentTime = 0
    setPlaying(false)
  }

  const medal =
    rank === 1 ? "from-[#feda75] to-[#fa7e1e]" : rank === 2 ? "from-[#d62976] to-[#962fbf]" : rank === 3 ? "from-[#962fbf] to-[#4f5bd5]" : ""

  return (
    <a
      href={reel.code ? `https://instagram.com/reel/${reel.code}` : undefined}
      target="_blank"
      rel="noreferrer"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="group relative block aspect-[9/16] overflow-hidden rounded-xl border border-border bg-secondary"
    >
      {/* Poster image (always present) */}
      {reel.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={reel.thumbnail || "/placeholder.svg"}
          alt={reel.caption?.slice(0, 60) || `Reel by ${reel.username}`}
          referrerPolicy="no-referrer"
          className={cn("absolute inset-0 size-full object-cover transition-opacity", playing && "opacity-0")}
        />
      ) : (
        <div className="absolute inset-0 ig-gradient opacity-20" />
      )}

      {/* Real video, revealed while playing */}
      {reel.videoUrl ? (
        <video
          ref={videoRef}
          src={reel.videoUrl}
          poster={reel.thumbnail}
          muted
          loop
          playsInline
          preload="none"
          className={cn("absolute inset-0 size-full object-cover transition-opacity", playing ? "opacity-100" : "opacity-0")}
        />
      ) : null}

      {/* Gradient legibility scrim */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-black/30" />

      {/* Rank badge */}
      <span
        className={cn(
          "absolute left-2 top-2 flex size-7 items-center justify-center rounded-full text-xs font-bold text-white shadow",
          rank <= 3 ? `bg-gradient-to-br ${medal}` : "bg-black/60 backdrop-blur",
        )}
      >
        {rank}
      </span>

      {/* Center play hint */}
      {!playing && reel.videoUrl ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-white/15 backdrop-blur transition-transform duration-300 group-hover:scale-110">
            <Play className="size-5 translate-x-0.5 fill-white text-white" />
          </span>
        </span>
      ) : null}

      {/* Views — the headline metric */}
      <div className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-xs font-semibold text-white backdrop-blur">
        <Eye className="size-3.5" />
        {formatCompact(reel.views)}
      </div>

      {/* Footer: account + likes/comments */}
      <div className="absolute inset-x-0 bottom-0 p-2.5 text-white">
        <p className="truncate text-xs font-semibold">@{reel.username}</p>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-white/85">
          <span className="flex items-center gap-1">
            <Heart className="size-3" /> {formatCompact(reel.likes)}
          </span>
          <span className="flex items-center gap-1">
            <MessageCircle className="size-3" /> {formatCompact(reel.comments)}
          </span>
        </div>
      </div>
    </a>
  )
}
