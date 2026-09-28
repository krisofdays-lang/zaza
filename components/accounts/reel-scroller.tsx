"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { toast } from "sonner"
import { fetchReelScroll, likeMediaAction, followAction, unfollowAction, saveMediaAction, repostMediaAction } from "@/app/actions/media"
import type { ExtractedMedia } from "@/lib/instagram/parse"
import { proxiedImage as px } from "@/lib/ig-image"
import { Heart, MessageCircle, Send, Loader2, ImageOff, Music2, MoreHorizontal, Repeat2, Volume2, VolumeX, Play, Bookmark } from "lucide-react"

function compact(n?: number) {
  if (n == null) return undefined
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + "K"
  return String(n)
}

/**
 * Full-screen vertical reels feed. Loads clips from the clips discover stream
 * (#12), plays the visible clip, and lazily loads the next page when the user
 * reaches the end. When the stream is exhausted it refetches from the top so
 * the feed keeps scrolling.
 */
export function ReelScroller({ accountId }: { accountId: number }) {
  const [items, setItems] = useState<ExtractedMedia[]>([])
  const [nextMaxId, setNextMaxId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const loadingRef = useRef(false)

  const load = useCallback(
    (maxId?: string) => {
      if (loadingRef.current) return
      loadingRef.current = true
      start(async () => {
        const res = await fetchReelScroll(accountId, maxId)
        setLoaded(true)
        if (!res.ok && res.error) setError(res.error)
        else if (!res.ok) setError(`Request failed (HTTP ${res.status})`)
        else setError(null)
        setItems((prev) => {
          if (!maxId) return res.items
          // de-dupe across pages
          const seen = new Set(prev.map((m) => m.id))
          return [...prev, ...res.items.filter((m) => !seen.has(m.id))]
        })
        setNextMaxId(res.nextMaxId ?? null)
        loadingRef.current = false
      })
    },
    [accountId],
  )

  useEffect(() => {
    load()
  }, [load])

  const loadMore = useCallback(() => {
    if (loadingRef.current) return
    if (nextMaxId) load(nextMaxId)
    else load() // exhausted — restart the stream so scrolling continues
  }, [nextMaxId, load])

  if (!loaded && pending) {
    return (
      <div className="flex h-full items-center justify-center bg-black">
        <Loader2 className="size-6 animate-spin text-white/70" />
      </div>
    )
  }

  if (error && items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-black px-6 text-center text-white/70">
        <ImageOff className="size-10" strokeWidth={1.2} />
        <p className="text-[14px]">{error}</p>
        <button onClick={() => load()} className="mt-2 text-[13px] font-semibold text-[#0095f6]">
          Try again
        </button>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-black text-white/60">
        <Music2 className="size-10" strokeWidth={1.2} />
        <p className="text-[14px]">No reels yet</p>
      </div>
    )
  }

  return (
    <div className="h-full snap-y snap-mandatory overflow-y-auto bg-black [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((m, i) => (
        <ReelItem
          key={m.id}
          media={m}
          accountId={accountId}
          isLast={i === items.length - 1}
          onReachEnd={loadMore}
        />
      ))}
      {pending && (
        <div className="flex h-12 items-center justify-center bg-black">
          <Loader2 className="size-5 animate-spin text-white/70" />
        </div>
      )}
    </div>
  )
}

function ReelItem({
  media,
  accountId,
  isLast,
  onReachEnd,
}: {
  media: ExtractedMedia
  accountId: number
  isLast: boolean
  onReachEnd: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const [liked, setLiked] = useState(false)
  const [burst, setBurst] = useState(false)
  const [muted, setMuted] = useState(true)
  const [paused, setPaused] = useState(false)
  const [following, setFollowing] = useState(false)
  const [followPending, setFollowPending] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reposted, setReposted] = useState(false)

  // Play only when this reel is the one in view (unless the user paused it).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        const vid = videoRef.current
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          if (!paused) vid?.play().catch(() => {})
          if (isLast) onReachEnd()
        } else {
          vid?.pause()
        }
      },
      { threshold: [0, 0.6, 1] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [isLast, onReachEnd, paused])

  // Tap toggles play/pause.
  const togglePlay = useCallback(() => {
    const vid = videoRef.current
    if (!vid) return
    if (vid.paused) {
      vid.play().catch(() => {})
      setPaused(false)
    } else {
      vid.pause()
      setPaused(true)
    }
  }, [])

  // Distinguish a tap (toggle play/pause) from a vertical drag (navigate reels).
  function onPointerDown(e: React.PointerEvent) {
    pointerStart.current = { x: e.clientX, y: e.clientY }
  }
  function onPointerUp(e: React.PointerEvent) {
    const start = pointerStart.current
    pointerStart.current = null
    if (!start) return
    const dy = e.clientY - start.y
    const dx = e.clientX - start.x
    if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) {
      const el = containerRef.current
      const target = (dy < 0 ? el?.nextElementSibling : el?.previousElementSibling) as HTMLElement | null
      target?.scrollIntoView({ behavior: "smooth" })
      return
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) togglePlay()
  }

  const doLike = useCallback(() => {
    if (liked) return
    setLiked(true)
    setBurst(true)
    setTimeout(() => setBurst(false), 700)
    likeMediaAction(accountId, media.id).then((r) => {
      if (!r.ok) {
        setLiked(false)
        toast.error(r.error || "Like failed")
      }
    })
  }, [accountId, media.id, liked])

  const toggleFollow = useCallback(() => {
    if (followPending) return
    if (!media.userId) {
      toast.error("Can't follow this account")
      return
    }
    const next = !following
    setFollowing(next)
    setFollowPending(true)
    const run = next ? followAction : unfollowAction
    run(accountId, media.userId, media.id).then((r) => {
      setFollowPending(false)
      if (!r.ok) {
        setFollowing(!next) // revert on failure
        toast.error(r.error || (next ? "Follow failed" : "Unfollow failed"))
      }
    })
  }, [accountId, media.userId, media.id, following, followPending])

  const toggleSave = useCallback(() => {
    const next = !saved
    setSaved(next)
    saveMediaAction(accountId, media.id).then((r) => {
      if (!r.ok) {
        setSaved(!next)
        toast.error(r.error || "Save failed")
      }
    })
  }, [accountId, media.id, saved])

  const doRepost = useCallback(() => {
    if (reposted) return
    setReposted(true)
    repostMediaAction(accountId, media.id).then((r) => {
      if (!r.ok) {
        setReposted(false)
        toast.error(r.error || "Repost failed")
      } else {
        toast.success("Reposted")
      }
    })
  }, [accountId, media.id, reposted])

  const likeStr = compact((media.likeCount ?? 0) + (liked ? 1 : 0))
  const commentStr = compact(media.commentCount)
  const shareStr = compact(media.reshareCount)

  return (
    <div ref={containerRef} className="relative h-full w-full shrink-0 snap-start snap-always bg-black">
      {/* Media — tap to play/pause, drag up/down to change reels, double-tap to like */}
      <div
        className="absolute inset-0 flex touch-none items-center justify-center"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (pointerStart.current = null)}
        onDoubleClick={doLike}
      >
        {media.videoUrl ? (
          <video
            ref={videoRef}
            src={media.videoUrl}
            poster={media.thumbnail}
            muted={muted}
            loop
            playsInline
            preload="metadata"
            className="size-full object-cover"
          />
        ) : media.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={px(media.thumbnail)} alt="reel" referrerPolicy="no-referrer" className="size-full object-cover" />
        ) : (
          <ImageOff className="size-10 text-white/40" />
        )}
        {burst && <Heart className="pointer-events-none absolute size-24 animate-ping fill-white text-white" />}
        {paused && media.videoUrl && (
          <div className="pointer-events-none absolute flex size-16 items-center justify-center rounded-full bg-black/45">
            <Play className="size-8 fill-white text-white" />
          </div>
        )}
      </div>

      {/* Sound toggle (top-right) */}
      {media.videoUrl && (
        <button
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? "Unmute" : "Mute"}
          className="absolute right-3 top-14 z-20 flex size-9 items-center justify-center rounded-full bg-black/45 text-white"
        >
          {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
        </button>
      )}

      {/* subtle gradient so text/icons are legible */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-black/70 to-transparent" />

      {/* Right action rail */}
      <div className="absolute bottom-6 right-2 z-10 flex flex-col items-center gap-5 text-white">
        <RailButton onClick={doLike} label={likeStr}>
          <Heart className={`size-7 ${liked ? "fill-[#ed4956] text-[#ed4956]" : "fill-white text-white"}`} strokeWidth={1.6} />
        </RailButton>
        <RailButton label={commentStr}>
          <MessageCircle className="size-7 -scale-x-100 text-white" strokeWidth={1.8} />
        </RailButton>
        <RailButton onClick={doRepost} label={shareStr}>
          <Repeat2 className={`size-7 ${reposted ? "text-[#3897f0]" : "text-white"}`} strokeWidth={2} />
        </RailButton>
        <RailButton onClick={toggleSave}>
          <Bookmark className={`size-7 ${saved ? "fill-white text-white" : "text-white"}`} strokeWidth={1.8} />
        </RailButton>
        <RailButton>
          <Send className="size-7 -rotate-12" strokeWidth={1.6} />
        </RailButton>
        <RailButton>
          <MoreHorizontal className="size-6" strokeWidth={2} />
        </RailButton>
        <div className="mt-1 size-7 overflow-hidden rounded-md border border-white/70">
          {media.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={px(media.thumbnail)} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
          ) : (
            <div className="size-full bg-white/20" />
          )}
        </div>
      </div>

      {/* Bottom author row */}
      <div className="absolute inset-x-0 bottom-4 z-10 px-3 pr-16 text-white">
        <div className="flex items-center gap-2">
          <div className="size-8 overflow-hidden rounded-full border border-white/80">
            {media.userProfilePic ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={px(media.userProfilePic)} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center bg-white/20 text-[11px] font-semibold">
                {(media.username || "?").slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
          <span className="text-[14px] font-semibold">{media.username || "instagram"}</span>
          <button
            onClick={toggleFollow}
            disabled={followPending}
            className={`rounded-lg border px-2.5 py-1 text-[12px] font-semibold disabled:opacity-60 ${
              following ? "border-white/40 text-white/80" : "border-white/70 text-white"
            }`}
          >
            {following ? "Unfollow" : "Follow"}
          </button>
        </div>
        {media.caption && <p className="mt-2 line-clamp-1 text-[13px] leading-[17px]">{media.caption}</p>}
      </div>
    </div>
  )
}

function RailButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label?: string
  onClick?: () => void
}) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1" aria-label="reel action">
      {children}
      {label && <span className="text-[12px] font-semibold tabular-nums drop-shadow">{label}</span>}
    </button>
  )
}
