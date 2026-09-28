"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { toast } from "sonner"
import {
  fetchPosts,
  fetchReels,
  fetchFeed,
  fetchExplore,
  fetchProfile,
  fetchStories,
  fetchComments,
  likeMediaAction,
  likeCommentAction,
  makeCommentAction,
  type MediaResult,
} from "@/app/actions/media"
import { ReelScroller } from "@/components/accounts/reel-scroller"
import { ReelComposer } from "@/components/accounts/reel-composer"
import type { ExtractedMedia, ExtractedComment, ExtractedStory, CarouselChild } from "@/lib/instagram/parse"
import type { DisplayAccount } from "@/app/actions/accounts"
import { proxiedImage as px } from "@/lib/ig-image"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  SquarePlus,
  Menu,
  Plus,
  Grid3x3,
  Clapperboard,
  Contact,
  Home,
  Search,
  Heart,
  Send,
  Loader2,
  Play,
  ImageOff,
  BadgeCheck,
  Lock,
  MessageCircle,
  Bookmark,
  X,
  Layers,
  MoreHorizontal,
} from "lucide-react"

interface ProfileShape {
  username?: string
  full_name?: string
  biography?: string
  profile_pic_url?: string
  follower_count?: number
  following_count?: number
  media_count?: number
  is_private?: boolean
  is_verified?: boolean
}

function compact(n?: number) {
  if (n == null) return "0"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M"
  if (n >= 10_000) return Math.round(n / 1000) + "K"
  if (n >= 1_000) return n.toLocaleString("en-US")
  return String(n)
}

type Screen = "profile" | "home" | "search" | "reels"
type ProfileTab = "grid" | "reels" | "tagged"

export function InstagramPhone({ account }: { account: DisplayAccount }) {
  const [screen, setScreen] = useState<Screen>("profile")
  const [composerOpen, setComposerOpen] = useState(false)
  const [profile, setProfile] = useState<ProfileShape>((account.profile ?? {}) as ProfileShape)

  // Load the live profile on open so the avatar + username appear immediately,
  // even for a freshly added account that has not been refreshed yet.
  useEffect(() => {
    let cancelled = false
    fetchProfile(account.id).then((r) => {
      if (!cancelled && r.ok && r.profile) setProfile(r.profile as ProfileShape)
    })
    return () => {
      cancelled = true
    }
  }, [account.id])

  const username = profile.username || account.username || account.label

  return (
    <div className="flex h-full flex-col bg-white font-sans text-[#000000]">
      <div className="relative min-h-0 flex-1">
        {screen === "profile" && <ProfileScreen account={account} profile={profile} username={username} />}
        {screen === "home" && <FeedScreen account={account} username={username} avatar={profile.profile_pic_url} />}
        {screen === "search" && <ExploreScreen account={account} />}
        {screen === "reels" && <ReelsScreen account={account} />}
        <ReelComposer account={account} open={composerOpen} onClose={() => setComposerOpen(false)} />
      </div>
      <BottomNav
        screen={screen}
        setScreen={setScreen}
        onCreate={() => setComposerOpen(true)}
        avatar={profile.profile_pic_url}
        username={username}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Profile screen (matches the reference screenshot)                   */
/* ------------------------------------------------------------------ */

function ProfileScreen({
  account,
  profile,
  username,
}: {
  account: DisplayAccount
  profile: ProfileShape
  username: string
}) {
  const [tab, setTab] = useState<ProfileTab>("grid")

  return (
    <div className="h-full overflow-y-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2">
        <button className="flex items-center gap-1 text-[22px] font-bold leading-none">
          <span className="max-w-[200px] truncate">{username}</span>
          {profile.is_verified && <BadgeCheck className="size-4 text-[#0095f6]" />}
          <ChevronDown className="size-5" strokeWidth={2.5} />
        </button>
        <div className="flex items-center gap-5">
          <SquarePlus className="size-[26px]" strokeWidth={1.8} />
          <Menu className="size-[26px]" strokeWidth={1.8} />
        </div>
      </header>

      {/* Avatar + stats */}
      <div className="flex items-center gap-7 px-4 pt-2">
        <StoryAvatar src={profile.profile_pic_url} name={username} withAddBadge />
        <div className="flex flex-1 items-center justify-around">
          <Stat value={compact(profile.media_count)} label="posts" />
          <Stat value={compact(profile.follower_count)} label="followers" />
          <Stat value={compact(profile.following_count)} label="following" />
        </div>
      </div>

      {/* Name + bio */}
      <div className="px-4 pt-3 text-[14px] leading-[19px]">
        <div className="flex items-center gap-1 font-semibold">
          {profile.full_name || username}
          {profile.is_private && <Lock className="size-3 text-[#737373]" />}
        </div>
        {profile.biography && <p className="whitespace-pre-wrap">{profile.biography}</p>}
      </div>

      {/* Dashboard card */}
      <div className="mx-4 mt-3 rounded-xl bg-[#f0f0f0] px-3.5 py-3">
        <p className="text-[14px] font-semibold">Your dashboard</p>
        <p className="mt-0.5 text-[13px] text-[#737373]">
          <span className="text-[#1a8917]">↗</span> {compact(profile.follower_count)} accounts reached recently.
        </p>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 px-4 pt-3 text-[14px] font-semibold">
        <button className="flex-1 rounded-lg bg-[#efefef] py-1.5">Edit profile</button>
        <button className="flex-1 rounded-lg bg-[#efefef] py-1.5">Share profile</button>
      </div>

      {/* Highlights */}
      <div className="flex gap-4 overflow-x-auto px-4 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Highlight isNew />
        <Highlight label="L!nk" src={profile.profile_pic_url} />
        <Highlight label="Diary" src={profile.profile_pic_url} />
      </div>

      {/* Tabs */}
      <div className="grid grid-cols-3 border-t border-[#dbdbdb]">
        <TabBtn active={tab === "grid"} onClick={() => setTab("grid")}>
          <Grid3x3 className="size-6" strokeWidth={tab === "grid" ? 2.2 : 1.8} />
        </TabBtn>
        <TabBtn active={tab === "reels"} onClick={() => setTab("reels")}>
          <Clapperboard className="size-6" strokeWidth={tab === "reels" ? 2.2 : 1.8} />
        </TabBtn>
        <TabBtn active={tab === "tagged"} onClick={() => setTab("tagged")}>
          <Contact className="size-6" strokeWidth={tab === "tagged" ? 2.2 : 1.8} />
        </TabBtn>
      </div>

      {/* Media grid */}
      {tab === "tagged" ? (
        <EmptyState icon={<Contact className="size-10" strokeWidth={1.2} />} text="Photos and videos of you" />
      ) : (
        <PhoneGrid
          key={`${account.id}-${tab}`}
          accountId={account.id}
          loader={(maxId) =>
            tab === "grid"
              ? fetchPosts(account.id, account.igUserId || undefined, maxId)
              : fetchReels(account.id, account.igUserId || undefined, maxId)
          }
          paginated
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Home feed screen                                                    */
/* ------------------------------------------------------------------ */

function FeedScreen({ account, username, avatar }: { account: DisplayAccount; username: string; avatar?: string }) {
  return (
    <div className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[#dbdbdb] bg-white px-4 py-2.5">
        <span className="font-[cursive] text-[24px] font-semibold tracking-tight">Instagram</span>
        <div className="flex items-center gap-5">
          <Plus className="size-[26px]" strokeWidth={2} />
          <Heart className="size-[26px]" strokeWidth={1.8} />
        </div>
      </header>
      <StoriesRow accountId={account.id} username={username} avatar={avatar} />
      <FeedList accountId={account.id} />
    </div>
  )
}

/* Stories tray (reels_tray). Own avatar first, then everyone with a live story. */
function StoriesRow({ accountId, username, avatar }: { accountId: number; username: string; avatar?: string }) {
  const [stories, setStories] = useState<ExtractedStory[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchStories(accountId).then((r) => {
      if (cancelled) return
      setLoaded(true)
      if (r.ok) setStories(r.items)
    })
    return () => {
      cancelled = true
    }
  }, [accountId])

  return (
    <div className="flex gap-4 overflow-x-auto border-b border-[#dbdbdb] px-3 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <StoryBubble src={avatar} label="Your story" own />
      {!loaded ? (
        <div className="flex items-center px-2">
          <Loader2 className="size-4 animate-spin text-[#737373]" />
        </div>
      ) : (
        stories.map((s) => (
          <StoryBubble key={s.id} src={s.profilePic} label={s.username} viewed={s.viewed} />
        ))
      )}
    </div>
  )
}

function StoryBubble({
  src,
  label,
  own,
  viewed,
}: {
  src?: string
  label: string
  own?: boolean
  viewed?: boolean
}) {
  const ring = own
    ? "bg-[#dbdbdb]"
    : viewed
      ? "bg-[#dbdbdb]"
      : "bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5]"
  return (
    <div className="flex w-[66px] shrink-0 flex-col items-center gap-1">
      <div className="relative">
        <div className={`rounded-full p-[2px] ${ring}`}>
          <div className="rounded-full bg-white p-[2px]">
            <div className="size-[60px] overflow-hidden rounded-full bg-[#efefef]">
              {src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={px(src)} alt={label} referrerPolicy="no-referrer" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-lg font-semibold text-[#737373]">
                  {label.slice(0, 1).toUpperCase()}
                </div>
              )}
            </div>
          </div>
        </div>
        {own && (
          <div className="absolute bottom-0 right-0 flex size-5 items-center justify-center rounded-full border-2 border-white bg-[#0095f6]">
            <Plus className="size-3 text-white" strokeWidth={3} />
          </div>
        )}
      </div>
      <span className="max-w-[66px] truncate text-[12px] leading-none">{own ? "Your story" : label}</span>
    </div>
  )
}

/* Vertical timeline of full posts (each post can be a carousel). */
function FeedList({ accountId }: { accountId: number }) {
  const [items, setItems] = useState<ExtractedMedia[]>([])
  const [nextMaxId, setNextMaxId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const load = useCallback(
    (maxId?: string) => {
      start(async () => {
        setError(null)
        const res = await fetchFeed(accountId, maxId)
        setLoaded(true)
        if (!res.ok && res.error) setError(res.error)
        else if (!res.ok) setError(`Request failed (HTTP ${res.status})`)
        setItems((prev) => {
          const merged = maxId ? [...prev, ...res.items] : res.items
          const seen = new Set<string>()
          return merged.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
        })
        setNextMaxId(res.nextMaxId ?? null)
      })
    },
    [accountId],
  )

  useEffect(() => {
    load()
  }, [load])

  if (!loaded && pending) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-[#737373]" />
      </div>
    )
  }

  if (error && items.length === 0) {
    return (
      <EmptyState
        icon={<ImageOff className="size-10 text-[#c7c7c7]" strokeWidth={1.2} />}
        text={error}
        action={
          <button onClick={() => load()} className="mt-2 text-[13px] font-semibold text-[#0095f6]">
            Try again
          </button>
        }
      />
    )
  }

  if (items.length === 0) {
    return <EmptyState icon={<Home className="size-10 text-[#c7c7c7]" strokeWidth={1.2} />} text="No posts yet" />
  }

  return (
    <div className="pb-4">
      {items.map((m) => (
        <FeedPost key={m.id} accountId={accountId} media={m} />
      ))}
      {nextMaxId && (
        <div className="flex justify-center py-4">
          <button
            onClick={() => load(nextMaxId)}
            disabled={pending}
            className="flex items-center gap-2 rounded-lg bg-[#efefef] px-4 py-1.5 text-[13px] font-semibold"
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            Load more
          </button>
        </div>
      )}
    </div>
  )
}

function FeedPost({ accountId, media }: { accountId: number; media: ExtractedMedia }) {
  const [liked, setLiked] = useState(false)
  const [burst, setBurst] = useState(false)
  const [showComments, setShowComments] = useState(false)

  const doLike = useCallback(() => {
    if (liked) return
    setLiked(true)
    setBurst(true)
    setTimeout(() => setBurst(false), 700)
    likeMediaAction(accountId, media.id).then((r) => {
      if (r.ok) toast.success("Liked")
      else {
        setLiked(false)
        toast.error(r.error || "Like failed")
      }
    })
  }, [accountId, media.id, liked])

  return (
    <article className="border-b border-[#efefef] pb-2">
      {/* author */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div className="rounded-full bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5] p-[2px]">
          <div className="size-8 overflow-hidden rounded-full bg-white p-[1.5px]">
            <div className="size-full overflow-hidden rounded-full bg-[#efefef]">
              {media.userProfilePic ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={px(media.userProfilePic)} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-[11px] font-semibold text-[#737373]">
                  {(media.username || "?").slice(0, 1).toUpperCase()}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="truncate text-[13px] font-semibold">{media.username || "instagram"}</span>
          {media.isVerified && <BadgeCheck className="size-3.5 shrink-0 text-[#0095f6]" />}
        </div>
        <MoreHorizontal className="size-5 shrink-0" />
      </div>

      {/* media (carousel-aware) */}
      <div onDoubleClick={doLike} className="relative">
        <MediaCarousel media={media} />
        {burst && (
          <Heart className="pointer-events-none absolute inset-0 m-auto size-24 animate-ping fill-white text-white" />
        )}
      </div>

      {/* actions */}
      <div className="flex items-center gap-4 px-3 pt-2.5">
        <button onClick={doLike} aria-label="Like">
          <Heart className={`size-7 ${liked ? "fill-[#ed4956] text-[#ed4956]" : ""}`} strokeWidth={1.8} />
        </button>
        <button onClick={() => setShowComments(true)} aria-label="Comment">
          <MessageCircle className="size-7 -scale-x-100" strokeWidth={1.8} />
        </button>
        <Send className="size-7 -rotate-12" strokeWidth={1.8} />
        <Bookmark className="ml-auto size-7" strokeWidth={1.8} />
      </div>

      {/* meta */}
      <div className="px-3 pt-2 text-[14px]">
        {typeof media.likeCount === "number" && (
          <p className="font-semibold">{compact(media.likeCount + (liked ? 1 : 0))} likes</p>
        )}
        {media.caption && (
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap leading-[19px]">
            {media.username && <span className="font-semibold">{media.username} </span>}
            {media.caption}
          </p>
        )}
        <button onClick={() => setShowComments(true)} className="mt-1 block text-[#737373]">
          {media.commentCount ? `View all ${compact(media.commentCount)} comments` : "View comments"}
        </button>
      </div>

      {showComments && (
        <div className="absolute inset-0 z-30">
          <CommentsOverlay accountId={accountId} mediaId={media.id} onClose={() => setShowComments(false)} />
        </div>
      )}
    </article>
  )
}

/* Swipeable media for a post: single image/video, or a carousel of slides.
   Supports click arrows (left/right) and pointer-drag swiping. */
function MediaCarousel({ media, contain }: { media: ExtractedMedia; contain?: boolean }) {
  const slides: CarouselChild[] =
    media.carousel && media.carousel.length
      ? media.carousel
      : [{ id: media.id, thumbnail: media.thumbnail, videoUrl: media.videoUrl, isVideo: media.isVideo }]
  const count = slides.length
  const [idx, setIdx] = useState(0)
  const dragX = useRef<number | null>(null)

  const fit = contain ? "object-contain" : "object-cover"
  const go = useCallback(
    (delta: number) => setIdx((i) => Math.max(0, Math.min(count - 1, i + delta))),
    [count],
  )

  function onPointerDown(e: React.PointerEvent) {
    dragX.current = e.clientX
  }
  function onPointerUp(e: React.PointerEvent) {
    if (dragX.current == null) return
    const dx = e.clientX - dragX.current
    dragX.current = null
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
  }

  return (
    <div className="relative overflow-hidden bg-black">
      <div
        className="flex aspect-square touch-pan-y transition-transform duration-300 ease-out"
        style={{ transform: `translateX(-${idx * 100}%)` }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (dragX.current = null)}
      >
        {slides.map((s) => (
          <div key={s.id} className="relative flex h-full w-full shrink-0 items-center justify-center">
            {s.videoUrl ? (
              <video src={s.videoUrl} poster={s.thumbnail} muted loop playsInline autoPlay className={`size-full ${fit}`} />
            ) : s.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={px(s.thumbnail)} alt="media" referrerPolicy="no-referrer" className={`size-full ${fit}`} />
            ) : (
              <ImageOff className="size-10 text-white/40" />
            )}
          </div>
        ))}
      </div>

      {count > 1 && (
        <>
          {idx > 0 && (
            <button
              onClick={() => go(-1)}
              aria-label="Previous"
              className="absolute left-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white"
            >
              <ChevronLeft className="size-5" />
            </button>
          )}
          {idx < count - 1 && (
            <button
              onClick={() => go(1)}
              aria-label="Next"
              className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white"
            >
              <ChevronRight className="size-5" />
            </button>
          )}
          <div className="absolute right-2.5 top-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[12px] font-semibold text-white">
            {idx + 1}/{count}
          </div>
          <div className="absolute inset-x-0 bottom-2.5 flex items-center justify-center gap-1.5">
            {slides.map((s, i) => (
              <span key={s.id} className={`size-1.5 rounded-full ${i === idx ? "bg-[#0095f6]" : "bg-white/60"}`} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Explore / search screen                                             */
/* ------------------------------------------------------------------ */

function ExploreScreen({ account }: { account: DisplayAccount }) {
  return (
    <div className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="sticky top-0 z-10 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2 rounded-lg bg-[#efefef] px-3 py-2 text-[15px] text-[#737373]">
          <Search className="size-4" />
          Search
        </div>
      </div>
      <PhoneGrid key={`${account.id}-explore`} accountId={account.id} loader={() => fetchExplore(account.id)} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Reels scroll screen                                                 */
/* ------------------------------------------------------------------ */

function ReelsScreen({ account }: { account: DisplayAccount }) {
  return (
    <div className="relative h-full bg-black">
      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-4 py-2.5 text-white">
        <span className="text-[22px] font-bold drop-shadow">Reels</span>
        <SquarePlus className="size-[26px] drop-shadow" strokeWidth={1.8} />
      </header>
      <ReelScroller key={`${account.id}-reelscroll`} accountId={account.id} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Shared media grid used by every screen                              */
/* ------------------------------------------------------------------ */

function PhoneGrid({
  accountId,
  loader,
  paginated = false,
}: {
  accountId: number
  loader: (maxId?: string) => Promise<MediaResult & { nextMaxId?: string | null }>
  paginated?: boolean
}) {
  const [items, setItems] = useState<ExtractedMedia[]>([])
  const [nextMaxId, setNextMaxId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<ExtractedMedia | null>(null)
  const [pending, start] = useTransition()

  const load = useCallback(
    (maxId?: string) => {
      start(async () => {
        setError(null)
        const res = await loader(maxId)
        setLoaded(true)
        if (!res.ok && res.error) setError(res.error)
        else if (!res.ok) setError(`Request failed (HTTP ${res.status})`)
        setItems((prev) => (maxId ? [...prev, ...res.items] : res.items))
        setNextMaxId(res.nextMaxId ?? null)
      })
    },
    [loader],
  )

  useEffect(() => {
    load()
  }, [load])

  if (!loaded && pending) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-[#737373]" />
      </div>
    )
  }

  if (error && items.length === 0) {
    return (
      <EmptyState
        icon={<ImageOff className="size-10 text-[#c7c7c7]" strokeWidth={1.2} />}
        text={error}
        action={
          <button onClick={() => load()} className="mt-2 text-[13px] font-semibold text-[#0095f6]">
            Try again
          </button>
        }
      />
    )
  }

  if (items.length === 0) {
    return <EmptyState icon={<Grid3x3 className="size-10 text-[#c7c7c7]" strokeWidth={1.2} />} text="No media yet" />
  }

  return (
    <div>
      <div className="grid grid-cols-3 gap-[2px]">
        {items.map((m) => (
          <button
            key={m.id}
            onClick={() => setActive(m)}
            className="relative aspect-square overflow-hidden bg-[#efefef]"
          >
            {m.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={px(m.thumbnail)}
                alt={m.caption ? m.caption.slice(0, 60) : "media"}
                referrerPolicy="no-referrer"
                className="size-full object-cover"
              />
            ) : (
              <div className="flex size-full items-center justify-center">
                <ImageOff className="size-5 text-[#c7c7c7]" />
              </div>
            )}
            {m.isCarousel ? (
              <Layers className="absolute right-1.5 top-1.5 size-4 fill-white text-white drop-shadow" />
            ) : (
              m.isVideo && <Play className="absolute right-1.5 top-1.5 size-4 fill-white text-white drop-shadow" />
            )}
          </button>
        ))}
      </div>
      {paginated && nextMaxId && (
        <div className="flex justify-center py-4">
          <button
            onClick={() => load(nextMaxId)}
            disabled={pending}
            className="flex items-center gap-2 rounded-lg bg-[#efefef] px-4 py-1.5 text-[13px] font-semibold"
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            Load more
          </button>
        </div>
      )}
      {active && <PostViewer accountId={accountId} media={active} onClose={() => setActive(null)} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tap-to-act post viewer: like, comment, like comments (real calls)   */
/* ------------------------------------------------------------------ */

function PostViewer({
  accountId,
  media,
  onClose,
}: {
  accountId: number
  media: ExtractedMedia
  onClose: () => void
}) {
  const [liked, setLiked] = useState(false)
  const [burst, setBurst] = useState(false)
  const [showComments, setShowComments] = useState(false)

  const doLike = useCallback(() => {
    if (liked) return
    setLiked(true)
    setBurst(true)
    setTimeout(() => setBurst(false), 700)
    likeMediaAction(accountId, media.id).then((r) => {
      if (r.ok) toast.success("Liked")
      else {
        setLiked(false)
        toast.error(r.error || "Like failed")
      }
    })
  }, [accountId, media.id, liked])

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-[#dbdbdb] px-3 py-2.5">
        <button onClick={onClose} aria-label="Close">
          <X className="size-6" />
        </button>
        <span className="text-[15px] font-semibold">{media.isCarousel ? "Carousel" : "Post"}</span>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="relative" onDoubleClick={doLike}>
          <MediaCarousel media={media} contain />
          {burst && (
            <Heart className="pointer-events-none absolute inset-0 m-auto size-24 animate-ping fill-white text-white" />
          )}
        </div>

        <div className="flex items-center gap-4 px-3 pt-3">
          <button onClick={doLike} aria-label="Like">
            <Heart className={`size-7 ${liked ? "fill-[#ed4956] text-[#ed4956]" : ""}`} strokeWidth={1.8} />
          </button>
          <button onClick={() => setShowComments(true)} aria-label="Comment">
            <MessageCircle className="size-7 -scale-x-100" strokeWidth={1.8} />
          </button>
          <Send className="size-7 -rotate-12" strokeWidth={1.8} />
          <Bookmark className="ml-auto size-7" strokeWidth={1.8} />
        </div>

        <div className="px-3 pt-2 text-[14px]">
          {typeof media.likeCount === "number" && (
            <p className="font-semibold">{compact(media.likeCount + (liked ? 1 : 0))} likes</p>
          )}
          {media.caption && (
            <p className="mt-1 whitespace-pre-wrap leading-[19px]">
              {media.username && <span className="font-semibold">{media.username} </span>}
              {media.caption}
            </p>
          )}
          <button onClick={() => setShowComments(true)} className="mt-1 text-[#737373]">
            {media.commentCount ? `View all ${compact(media.commentCount)} comments` : "View comments"}
          </button>
        </div>
      </div>

      {showComments && <CommentsOverlay accountId={accountId} mediaId={media.id} onClose={() => setShowComments(false)} />}
    </div>
  )
}

/* Comments sheet shared by the feed and the grid post viewer. */
function CommentsOverlay({
  accountId,
  mediaId,
  onClose,
}: {
  accountId: number
  mediaId: string
  onClose: () => void
}) {
  const [comments, setComments] = useState<ExtractedComment[]>([])
  const [loadingComments, setLoadingComments] = useState(true)
  const [draft, setDraft] = useState("")
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchComments(accountId, mediaId).then((r) => {
      if (cancelled) return
      setLoadingComments(false)
      if (r.ok) setComments(r.items)
      else toast.error(r.error || "Could not load comments")
    })
    return () => {
      cancelled = true
    }
  }, [accountId, mediaId])

  function postComment() {
    const text = draft.trim()
    if (!text) return
    setPosting(true)
    makeCommentAction(accountId, mediaId, text).then((r) => {
      setPosting(false)
      if (r.ok) {
        toast.success("Comment posted")
        setComments((prev) => [{ id: `local-${Date.now()}`, text, username: "you" }, ...prev])
        setDraft("")
      } else {
        toast.error(r.error || "Comment failed")
      }
    })
  }

  function likeAComment(id: string) {
    likeCommentAction(accountId, id).then((r) => {
      if (r.ok) toast.success("Comment liked")
      else toast.error(r.error || "Failed")
    })
  }

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-white">
      <header className="flex items-center justify-between border-b border-[#dbdbdb] px-3 py-2.5">
        <span className="text-[15px] font-semibold">Comments</span>
        <button onClick={onClose} aria-label="Close comments">
          <X className="size-6" />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {loadingComments ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-[#737373]" />
          </div>
        ) : comments.length === 0 ? (
          <p className="py-10 text-center text-[14px] text-[#737373]">No comments yet</p>
        ) : (
          comments.map((c) => (
            <div key={c.id} className="flex items-start gap-2 py-2">
              <div className="size-8 shrink-0 overflow-hidden rounded-full bg-[#efefef]">
                {c.profilePic && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={px(c.profilePic)} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
                )}
              </div>
              <div className="flex-1 text-[13px] leading-[17px]">
                <span className="font-semibold">{c.username || "user"}</span> {c.text}
              </div>
              <button onClick={() => likeAComment(c.id)} aria-label="Like comment">
                <Heart className="size-3.5 text-[#737373]" />
              </button>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-[#dbdbdb] px-3 py-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment..."
          className="flex-1 bg-transparent text-[14px] outline-none"
        />
        <button
          onClick={postComment}
          disabled={posting || !draft.trim()}
          className="text-[14px] font-semibold text-[#0095f6] disabled:opacity-40"
        >
          {posting ? "..." : "Post"}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Bits                                                                */
/* ------------------------------------------------------------------ */

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="text-[17px] font-bold leading-tight tabular-nums">{value}</div>
      <div className="text-[14px] text-[#262626]">{label}</div>
    </div>
  )
}

function StoryAvatar({ src, name, withAddBadge }: { src?: string; name: string; withAddBadge?: boolean }) {
  return (
    <div className="relative">
      <div className="rounded-full bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5] p-[2.5px]">
        <div className="rounded-full bg-white p-[2px]">
          <div className="size-[86px] overflow-hidden rounded-full bg-[#efefef]">
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={px(src)} alt={name} referrerPolicy="no-referrer" className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center text-2xl font-semibold text-[#737373]">
                {name.slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
        </div>
      </div>
      {withAddBadge && (
        <div className="absolute bottom-0 right-0 flex size-6 items-center justify-center rounded-full border-2 border-white bg-[#0095f6]">
          <Plus className="size-3.5 text-white" strokeWidth={3} />
        </div>
      )}
    </div>
  )
}

function Highlight({ label, src, isNew }: { label?: string; src?: string; isNew?: boolean }) {
  return (
    <div className="flex w-[64px] shrink-0 flex-col items-center gap-1">
      {isNew ? (
        <div className="flex size-[64px] items-center justify-center rounded-full border border-[#dbdbdb]">
          <Plus className="size-7 text-[#262626]" strokeWidth={1.5} />
        </div>
      ) : (
        <div className="size-[64px] overflow-hidden rounded-full border border-[#dbdbdb] p-[2px]">
          <div className="size-full overflow-hidden rounded-full bg-[#efefef]">
            {src && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={px(src)} alt={label} referrerPolicy="no-referrer" className="size-full object-cover" />
            )}
          </div>
        </div>
      )}
      <span className="max-w-[64px] truncate text-[12px]">{isNew ? "New" : label}</span>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-center border-b py-2.5 ${
        active ? "border-black text-black" : "border-transparent text-[#8e8e8e]"
      }`}
    >
      {children}
    </button>
  )
}

function EmptyState({ icon, text, action }: { icon: React.ReactNode; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-[#737373]">
      {icon}
      <p className="text-[14px]">{text}</p>
      {action}
    </div>
  )
}

function BottomNav({
  screen,
  setScreen,
  onCreate,
  avatar,
  username,
}: {
  screen: Screen
  setScreen: (s: Screen) => void
  onCreate: () => void
  avatar?: string
  username: string
}) {
  return (
    <nav className="z-20 flex shrink-0 items-center justify-around border-t border-[#dbdbdb] bg-white px-2 pb-5 pt-2.5">
      <button onClick={() => setScreen("home")} aria-label="Home">
        <Home className="size-7" strokeWidth={screen === "home" ? 2.6 : 1.8} fill={screen === "home" ? "#000" : "none"} />
      </button>
      <button onClick={() => setScreen("search")} aria-label="Search">
        <Search className="size-7" strokeWidth={screen === "search" ? 2.6 : 1.8} />
      </button>
      <button onClick={onCreate} aria-label="Create">
        <SquarePlus className="size-7" strokeWidth={1.8} />
      </button>
      <button onClick={() => setScreen("reels")} aria-label="Reels">
        <Clapperboard className="size-7" strokeWidth={screen === "reels" ? 2.6 : 1.8} />
      </button>
      <button onClick={() => setScreen("profile")} aria-label="Profile">
        <div
          className={`size-7 overflow-hidden rounded-full ${
            screen === "profile" ? "ring-2 ring-black" : "ring-1 ring-[#dbdbdb]"
          }`}
        >
          {avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={px(avatar)} alt={username} referrerPolicy="no-referrer" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center bg-[#efefef] text-[10px] font-semibold text-[#737373]">
              {username.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>
      </button>
    </nav>
  )
}
