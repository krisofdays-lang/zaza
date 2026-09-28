import { InstagramClient, type IgResponse } from "./client"
import * as ep from "./endpoints"
import type { IgAccount } from "@/lib/db/schema"

export type ParamType = "text" | "number"

export interface ActionParam {
  key: string
  label: string
  type: ParamType
  required?: boolean
  placeholder?: string
}

export interface ActionDef {
  key: string
  order: number // execution order from the request filenames
  label: string
  description: string
  category: "profile" | "feed" | "engage" | "discover"
  params: ActionParam[]
  run: (c: InstagramClient, params: Record<string, string>, account: IgAccount) => Promise<IgResponse>
}

const userIdParam: ActionParam = {
  key: "userId",
  label: "Target user ID",
  type: "text",
  placeholder: "e.g. 41208142446 (leave empty for self)",
}

export const ACTIONS: ActionDef[] = [
  {
    key: "profile_info",
    order: 1,
    label: "Profile info",
    description: "Fetch full profile information for a user.",
    category: "profile",
    params: [userIdParam],
    run: (c, p) => ep.profileInfo(c, p.userId || c.uid),
  },
  {
    key: "profile_posts",
    order: 2,
    label: "Posts from profile",
    description: "Fetch the post grid for a profile.",
    category: "profile",
    params: [userIdParam, { key: "maxId", label: "Cursor (max_id)", type: "text" }],
    run: (c, p) => ep.profilePosts(c, p.userId || c.uid, p.maxId || null),
  },
  {
    key: "profile_reels",
    order: 3,
    label: "Reels from profile",
    description: "Fetch the reels stream for a profile.",
    category: "profile",
    params: [userIdParam, { key: "maxId", label: "Cursor (max_id)", type: "text" }],
    run: (c, p) => ep.profileReels(c, p.userId || c.uid, p.maxId || null),
  },
  {
    key: "highlights",
    order: 4,
    label: "Highlights",
    description: "Fetch the highlights tray for a profile.",
    category: "profile",
    params: [userIdParam],
    run: (c, p) => ep.highlights(c, p.userId || c.uid),
  },
  {
    key: "reels_tray",
    order: 7,
    label: "Feed: reels tray",
    description: "Feed request 1 — load the stories tray.",
    category: "feed",
    params: [],
    run: (c) => ep.reelsTray(c),
  },
  {
    key: "feed_timeline",
    order: 8,
    label: "Feed: timeline",
    description: "Feed request 2 — load the home timeline.",
    category: "feed",
    params: [],
    run: (c) => ep.feedTimeline(c, { reason: "cold_start_fetch" }),
  },
  {
    key: "reels_media_stream",
    order: 9,
    label: "Feed: reels media stream",
    description: "Feed request 3 — play story reels.",
    category: "feed",
    params: [{ key: "reelIds", label: "Reel IDs (comma separated)", type: "text" }],
    run: (c, p) =>
      ep.reelsMediaStream(
        c,
        (p.reelIds || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  },
  {
    key: "feed_timeline_scroll",
    order: 10,
    label: "Feed: timeline scroll",
    description: "Feed request 2 — paginate the timeline.",
    category: "feed",
    params: [{ key: "maxId", label: "Cursor (max_id)", type: "text", required: true }],
    run: (c, p) => ep.feedTimeline(c, { maxId: p.maxId, reason: "pagination" }),
  },
  {
    key: "explore",
    order: 11,
    label: "Explore / Search",
    description: "Topical explore feed. Battery level is sent as a signal.",
    category: "discover",
    params: [{ key: "batteryLevel", label: "Battery level (0-100)", type: "number", placeholder: "42" }],
    run: (c, p) => ep.explore(c, { batteryLevel: p.batteryLevel ? Number(p.batteryLevel) : undefined }),
  },
  {
    key: "reel_scroll",
    order: 12,
    label: "Reel scrolling",
    description: "Clips discover stream. Run again when all are shown.",
    category: "discover",
    params: [{ key: "maxId", label: "Cursor (max_id)", type: "text" }],
    run: (c, p) => ep.reelScroll(c, { maxId: p.maxId || null }),
  },
  {
    key: "like_media",
    order: 13,
    label: "Like media",
    description: "Like a post or reel.",
    category: "engage",
    params: [{ key: "mediaId", label: "Media ID", type: "text", required: true, placeholder: "3926160855091030553_53107158521" }],
    run: (c, p) => ep.likeMedia(c, p.mediaId),
  },
  {
    key: "media_comments",
    order: 14,
    label: "Check media comments",
    description: "Fetch the comments of a media.",
    category: "engage",
    params: [{ key: "mediaId", label: "Media ID", type: "text", required: true }],
    run: (c, p) => ep.mediaComments(c, p.mediaId),
  },
  {
    key: "comment_replies",
    order: 15,
    label: "Check comment replies",
    description: "Fetch inline child comments of a comment.",
    category: "engage",
    params: [
      { key: "mediaId", label: "Media ID", type: "text", required: true },
      { key: "commentId", label: "Comment ID", type: "text", required: true },
    ],
    run: (c, p) => ep.commentReplies(c, p.mediaId, p.commentId),
  },
  {
    key: "comment_like",
    order: 16,
    label: "Like comment",
    description: "Like a specific comment.",
    category: "engage",
    params: [{ key: "commentId", label: "Comment ID", type: "text", required: true }],
    run: (c, p) => ep.commentLike(c, p.commentId),
  },
  {
    key: "check_offensive",
    order: 17,
    label: "Check offensive (pre-comment)",
    description: "Request that must run right before making a comment.",
    category: "engage",
    params: [
      { key: "mediaId", label: "Media ID", type: "text", required: true },
      { key: "commentText", label: "Comment text", type: "text", required: true },
    ],
    run: (c, p) => ep.checkOffensiveComment(c, p.mediaId, p.commentText),
  },
  {
    key: "make_comment",
    order: 18,
    label: "Make comment",
    description: "Post a comment. Runs the offensive check first automatically.",
    category: "engage",
    params: [
      { key: "mediaId", label: "Media ID", type: "text", required: true },
      { key: "commentText", label: "Comment text", type: "text", required: true },
    ],
    run: async (c, p) => {
      // Step 17 must precede step 18 — run the offensive check first.
      await ep.checkOffensiveComment(c, p.mediaId, p.commentText)
      return ep.makeComment(c, p.mediaId, p.commentText)
    },
  },
  {
    key: "follow",
    order: 19,
    label: "Follow user",
    description: "Send a follow request to a user.",
    category: "engage",
    params: [{ key: "targetUserId", label: "Target user ID", type: "text", required: true }],
    run: (c, p) => ep.follow(c, p.targetUserId),
  },
]

export function getAction(key: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.key === key)
}

export interface WorkflowStep {
  action: string
  params: Record<string, string>
  delayMs?: number
}
