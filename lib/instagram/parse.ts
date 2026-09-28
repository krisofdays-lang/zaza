// Instagram's private API returns deeply nested and inconsistent JSON shapes
// across endpoints (REST feed, GraphQL profile queries, streaming chunks).
// These helpers walk the response tree and pull out displayable media so the
// UI does not need to know each exact shape.

export interface CarouselChild {
  id: string
  thumbnail?: string
  videoUrl?: string
  isVideo: boolean
}

export interface ExtractedMedia {
  id: string
  code?: string
  thumbnail?: string
  videoUrl?: string
  isVideo: boolean
  caption?: string
  likeCount?: number
  commentCount?: number
  viewCount?: number
  reshareCount?: number
  username?: string
  userProfilePic?: string
  isVerified?: boolean
  // The author's numeric pk — required to follow/unfollow them from the reel.
  userId?: string
  // Injected ad / sponsored / paid-partnership posts. Instagram rejects
  // like/save/follow on these (HTTP 400), so warm-up should skip interacting
  // with them and only "watch".
  isAd?: boolean
  // A carousel (media_type 8) is one post that holds several photos/videos.
  // When present, the UI should show this as a single grid tile but let the
  // viewer swipe through every child.
  isCarousel?: boolean
  carousel?: CarouselChild[]
}

// Several IG endpoints (notably info_stream) return a chunked response that is
// actually MULTIPLE top-level JSON objects concatenated back-to-back, e.g.
// `{"user":{...}}{"user":{...}}`. axios cannot JSON.parse that, so it leaves the
// body as a raw string. This splits the raw text into balanced top-level objects
// and parses each one individually.
export function parseStreamObjects(raw: unknown): Record<string, unknown>[] {
  // When the response travels through the uTLS proxy (or arrives gzip/br
  // encoded), axios can hand us the raw body as a Buffer / typed array / string
  // rather than a parsed object. Decode any binary form to UTF-8 text FIRST so
  // the concatenated-objects splitter below can run — otherwise a Buffer would
  // fall into the `typeof === "object"` branch and be treated as one opaque
  // object with no `user`, producing the bogus "Refresh failed 200".
  if (raw instanceof Uint8Array) raw = new TextDecoder().decode(raw)
  else if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) raw = raw.toString("utf8")
  else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(new Uint8Array(raw))
  // A string that is actually a single JSON object/array should be parsed too,
  // not just multi-object streams. Try a direct parse before the char-scanner.
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === "object")
        if (parsed && typeof parsed === "object") return [parsed as Record<string, unknown>]
      } catch {
        // not a single valid JSON doc — fall through to the multi-object scanner
      }
    }
  }
  if (raw && typeof raw === "object") return [raw as Record<string, unknown>]
  if (typeof raw !== "string") return []
  const objects: Record<string, unknown>[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === "{") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(raw.slice(start, i + 1)))
        } catch {
          // skip malformed fragment
        }
        start = -1
      }
    }
  }
  return objects
}

// Pull the most complete `user` object out of an info_stream response (which may
// be a parsed object, a raw string, or several concatenated chunks).
export function extractProfileUser(raw: unknown): Record<string, unknown> | null {
  const objs = parseStreamObjects(raw)
  let best: Record<string, unknown> | null = null
  for (const o of objs) {
    const user = (o.user ?? o) as Record<string, unknown> | undefined
    if (user && (user.pk != null || typeof user.username === "string")) {
      if (!best || Object.keys(user).length > Object.keys(best).length) best = user
    }
  }
  return best
}

function pickThumb(node: Record<string, unknown>): string | undefined {
  const iv2 = node.image_versions2 as { candidates?: { url?: string; width?: number }[] } | undefined
  if (iv2?.candidates?.length) {
    // Prefer a medium candidate for grid display.
    const sorted = [...iv2.candidates].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    return sorted[Math.min(1, sorted.length - 1)]?.url ?? sorted[0]?.url
  }
  const ev = node.video_versions as { url?: string }[] | undefined
  if (Array.isArray(ev) && ev[0]?.url) return ev[0].url
  return undefined
}

function pickVideo(node: Record<string, unknown>): string | undefined {
  const ev = node.video_versions as { url?: string; type?: number }[] | undefined
  if (Array.isArray(ev) && ev.length) {
    // type 101 is the standard progressive MP4; fall back to the first entry.
    const progressive = ev.find((v) => v.type === 101)
    return (progressive ?? ev[0])?.url
  }
  return undefined
}

function captionText(node: Record<string, unknown>): string | undefined {
  const cap = node.caption as { text?: string } | string | undefined
  if (typeof cap === "string") return cap
  return cap?.text
}

// The numeric primary key that identifies a media item. Both `pk` and the
// composite `id`/`strong_id__` ("{pk}_{ownerId}") map back to the same pk, which
// lets us merge fragments of the same post that arrive in different chunks.
function pkOf(node: Record<string, unknown>): string | null {
  if (node.pk != null) return String(node.pk)
  const id = node.id ?? node.strong_id__
  if (typeof id === "string") return id.includes("_") ? id.split("_")[0] : id
  if (id != null) return String(id)
  return null
}

function hasMediaResources(node: Record<string, unknown>): boolean {
  return "image_versions2" in node || "video_versions" in node || Array.isArray(node.carousel_media)
}

// A node that describes (part of) a media post. The profile timeline streams the
// thumbnail in one chunk and the engagement (likes / caption / author) in a
// later deferred chunk, so we accept engagement-only fragments too and merge
// them by pk. User objects (which also carry pk/id) are excluded.
function looksLikeMedia(node: Record<string, unknown>): boolean {
  if (typeof node.username === "string") return false // this is a user object
  if (typeof node.text === "string" && "comment_like_count" in node) return false // a comment
  if (!pkOf(node)) return false
  if (hasMediaResources(node)) return true
  return (
    "media_type" in node ||
    "product_type" in node ||
    "like_count" in node ||
    "comment_count" in node ||
    "play_count" in node ||
    (node.caption != null && typeof node.caption === "object")
  )
}

// The full media id ("{pk}_{ownerId}") that the like / comments endpoints
// require. Falls back to building it from pk + owner, then to the bare pk.
function fullMediaId(node: Record<string, unknown>): string {
  const rawId = node.id ?? node.strong_id__
  if (typeof rawId === "string" && rawId.includes("_")) return rawId
  const pk = pkOf(node) ?? ""
  const user = node.user as { pk?: unknown; id?: unknown } | undefined
  const owner = user?.pk ?? user?.id ?? node.user_id
  if (pk && owner != null && !pk.includes("_")) return `${pk}_${owner}`
  return pk
}

// Merge a freshly seen fragment into the accumulated media node, preferring
// non-null values and the richer variants (composite id, longer carousel, a
// user that actually has a username).
function mergeMediaNode(acc: Record<string, unknown>, node: Record<string, unknown>) {
  for (const key of Object.keys(node)) {
    const incoming = node[key]
    if (incoming == null) continue
    const current = acc[key]
    if (current == null) {
      acc[key] = incoming
      continue
    }
    if (key === "id" || key === "strong_id__") {
      if (typeof incoming === "string" && incoming.includes("_")) acc[key] = incoming
    } else if (key === "carousel_media") {
      if (Array.isArray(incoming) && (!Array.isArray(current) || incoming.length > current.length)) acc[key] = incoming
    } else if (key === "user") {
      const inUser = incoming as { username?: unknown }
      const curUser = current as { username?: unknown }
      if (inUser?.username && !curUser?.username) acc[key] = incoming
    }
  }
}

// Build the list of child slides for a carousel post (media_type 8).
function buildCarousel(node: Record<string, unknown>): CarouselChild[] | undefined {
  const arr = node.carousel_media
  if (!Array.isArray(arr) || arr.length === 0) return undefined
  return arr.map((raw, i) => {
    const child = (raw ?? {}) as Record<string, unknown>
    return {
      id: String(child.pk ?? child.id ?? child.strong_id__ ?? `${node.pk ?? node.id}-${i}`),
      thumbnail: pickThumb(child),
      videoUrl: pickVideo(child),
      isVideo: child.media_type === 2 || "video_versions" in child,
    }
  })
}

// Detect injected ad / sponsored posts. The home feed interleaves paid posts
// that cannot be liked or saved; they carry one of several markers.
function looksLikeAd(node: Record<string, unknown>): boolean {
  return (
    node.injected != null ||
    node.ad_id != null ||
    node.is_ad === true ||
    node.ad_action != null ||
    node.dr_ad_type != null ||
    typeof node.label_for_x_ad_below_engagement_bar === "string" ||
    node.commerciality_status === "commercial"
  )
}

function toExtracted(node: Record<string, unknown>): ExtractedMedia | null {
  const carousel = buildCarousel(node)
  const thumbnail = pickThumb(node) ?? carousel?.[0]?.thumbnail
  const videoUrl = pickVideo(node) ?? carousel?.find((c) => c.videoUrl)?.videoUrl
  // Drop fragments that never received any displayable media.
  if (!thumbnail && !videoUrl && !carousel) return null
  const user = node.user as
    | { pk?: unknown; id?: unknown; username?: string; profile_pic_url?: string; is_verified?: boolean }
    | undefined
  const ownerPk = user?.pk ?? user?.id ?? node.user_id
  return {
    id: fullMediaId(node),
    userId: ownerPk != null ? String(ownerPk) : undefined,
    isAd: looksLikeAd(node) || undefined,
    code: typeof node.code === "string" ? node.code : undefined,
    thumbnail,
    videoUrl: pickVideo(node),
    isVideo: node.media_type === 2 || "video_versions" in node || (!!carousel && carousel[0]?.isVideo),
    caption: captionText(node),
    likeCount: typeof node.like_count === "number" ? node.like_count : undefined,
    commentCount: typeof node.comment_count === "number" ? node.comment_count : undefined,
    reshareCount: typeof node.reshare_count === "number" ? node.reshare_count : undefined,
    viewCount:
      typeof node.play_count === "number"
        ? node.play_count
        : typeof node.view_count === "number"
          ? node.view_count
          : undefined,
    username: user?.username,
    userProfilePic: user?.profile_pic_url,
    isVerified: user?.is_verified,
    isCarousel: !!carousel,
    carousel,
  }
}

// Recursively collect media nodes, merging fragments of the same post (by pk)
// that arrive across separate deferred stream chunks.
export function extractMedia(data: unknown, limit = 60): ExtractedMedia[] {
  // Insertion-ordered accumulator keyed by media pk.
  const merged = new Map<string, Record<string, unknown>>()

  function walk(value: unknown, depth: number) {
    if (depth > 14 || value == null) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (typeof value !== "object") return
    const node = value as Record<string, unknown>

    if (looksLikeMedia(node)) {
      const key = pkOf(node)
      if (key) {
        const acc = merged.get(key)
        if (acc) mergeMediaNode(acc, node)
        else merged.set(key, { ...node })
      }
      // A media node is a single post. Do NOT recurse into it — otherwise the
      // children of a carousel would be picked up as separate grid items.
      return
    }

    for (const k of Object.keys(node)) walk(node[k], depth + 1)
  }

  // Some endpoints (reels clips stream, reels_tray, profile timeline) return
  // several JSON objects concatenated as one string. Parse each and walk them.
  if (typeof data === "string") {
    for (const o of parseStreamObjects(data)) walk(o, 0)
  } else {
    walk(data, 0)
  }

  const out: ExtractedMedia[] = []
  for (const node of merged.values()) {
    const m = toExtracted(node)
    if (m) out.push(m)
    if (out.length >= limit) break
  }
  return out
}

// Cursor for "load more", resilient to both single-object and chunked-stream
// responses.
export function extractNextCursor(data: unknown): string | null {
  const fromObj = (d: Record<string, unknown> | undefined): string | null => {
    if (!d) return null
    const paging = d.paging_info as { max_id?: string } | undefined
    const next = (d.next_max_id as string | undefined) ?? paging?.max_id
    return typeof next === "string" && next ? next : null
  }
  if (data && typeof data === "object") return fromObj(data as Record<string, unknown>)
  if (typeof data === "string") {
    const objs = parseStreamObjects(data)
    for (let i = objs.length - 1; i >= 0; i--) {
      const c = fromObj(objs[i])
      if (c) return c
    }
  }
  return null
}

export interface ExtractedStory {
  id: string
  username: string
  fullName?: string
  profilePic?: string
  // true once the viewer has already watched this person's latest story.
  viewed: boolean
}

// Pull the stories tray out of /feed/reels_tray/ (chunked stream). Only real
// user reels with a live story are returned; suggested users without media are
// skipped.
export function extractStories(data: unknown, limit = 30): ExtractedStory[] {
  const objs = parseStreamObjects(data)
  const out: ExtractedStory[] = []
  const seen = new Set<string>()
  for (const o of objs) {
    const tray = o.tray as Record<string, unknown>[] | undefined
    if (!Array.isArray(tray)) continue
    for (const item of tray) {
      const reelType = item.reel_type as string | undefined
      if (reelType && reelType !== "user_reel") continue
      const latest = item.latest_reel_media as number | null | undefined
      if (latest == null) continue // no live story
      const user = item.user as
        | { username?: string; full_name?: string; profile_pic_url?: string }
        | undefined
      if (!user?.username) continue
      const id = String(item.id ?? item.strong_id__ ?? user.username)
      if (seen.has(id)) continue
      seen.add(id)
      const seenTs = typeof item.seen === "number" ? item.seen : 0
      out.push({
        id,
        username: user.username,
        fullName: typeof user.full_name === "string" ? user.full_name : undefined,
        profilePic: typeof user.profile_pic_url === "string" ? user.profile_pic_url : undefined,
        viewed: seenTs > 0 && seenTs >= latest,
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

export interface ExtractedComment {
  id: string
  text: string
  username?: string
  likeCount?: number
  profilePic?: string
  replyCount?: number
}

export function extractComments(data: unknown, limit = 40): ExtractedComment[] {
  const root = data as { comments?: unknown[]; child_comments?: unknown[] } | undefined
  const list = (root?.comments ?? root?.child_comments ?? []) as Record<string, unknown>[]
  const out: ExtractedComment[] = []
  for (const c of list) {
    if (out.length >= limit) break
    const user = c.user as { username?: string; profile_pic_url?: string } | undefined
    out.push({
      id: String(c.pk ?? c.id ?? ""),
      text: String(c.text ?? ""),
      username: user?.username,
      profilePic: user?.profile_pic_url,
      likeCount: typeof c.comment_like_count === "number" ? c.comment_like_count : undefined,
      replyCount: typeof c.child_comment_count === "number" ? c.child_comment_count : undefined,
    })
  }
  return out
}
