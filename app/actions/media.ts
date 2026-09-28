"use server"

import { getAccount } from "./accounts"
import { db } from "@/lib/db"
import { igAccounts } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import {
  extractMedia,
  extractComments,
  extractProfileUser,
  extractStories,
  extractNextCursor,
  type ExtractedMedia,
  type ExtractedComment,
  type ExtractedStory,
} from "@/lib/instagram/parse"

export interface ProfileResult {
  ok: boolean
  status: number
  profile: Record<string, unknown> | null
  error?: string
}

// Fetch the live profile (info_stream #1), persist it, and return the user object
// so the phone UI can show the avatar + username immediately on open.
export async function fetchProfile(accountId: number): Promise<ProfileResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, profile: null, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.profileInfo(c, account.igUserId || c.uid)
    const user = res.ok ? extractProfileUser(res.data) : null
    if (user) {
      await db
        .update(igAccounts)
        .set({
          profile: user,
          username: (user.username as string) || account.username,
          igUserId: user.pk != null ? String(user.pk) : account.igUserId,
          status: "ok",
          lastCheckedAt: new Date(),
          lastError: "",
        })
        .where(eq(igAccounts.id, accountId))
    }
    return { ok: !!user, status: res.status, profile: user }
  } catch (e) {
    return { ok: false, status: 0, profile: null, error: e instanceof Error ? e.message : "failed" }
  }
}

export interface MediaResult {
  ok: boolean
  status: number
  items: ExtractedMedia[]
  error?: string
}

function nextCursor(data: unknown): string | null {
  return extractNextCursor(data)
}

export async function fetchPosts(accountId: number, userId?: string, maxId?: string): Promise<MediaResult & { nextMaxId: string | null }> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, items: [], nextMaxId: null, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.profilePosts(c, userId || account.igUserId || c.uid, maxId || null)
    return { ok: res.ok, status: res.status, items: extractMedia(res.data), nextMaxId: nextCursor(res.data) }
  } catch (e) {
    return { ok: false, status: 0, items: [], nextMaxId: null, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function fetchReels(accountId: number, userId?: string, maxId?: string): Promise<MediaResult & { nextMaxId: string | null }> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, items: [], nextMaxId: null, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.profileReels(c, userId || account.igUserId || c.uid, maxId || null)
    return { ok: res.ok, status: res.status, items: extractMedia(res.data), nextMaxId: nextCursor(res.data) }
  } catch (e) {
    return { ok: false, status: 0, items: [], nextMaxId: null, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function fetchHighlights(accountId: number, userId?: string): Promise<MediaResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, items: [], error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.highlights(c, userId || account.igUserId || c.uid)
    return { ok: res.ok, status: res.status, items: extractMedia(res.data) }
  } catch (e) {
    return { ok: false, status: 0, items: [], error: e instanceof Error ? e.message : "failed" }
  }
}

export async function fetchFeed(accountId: number, maxId?: string): Promise<MediaResult & { nextMaxId: string | null }> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, items: [], nextMaxId: null, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.feedTimeline(c, { maxId: maxId || null, reason: maxId ? "pagination" : "cold_start_fetch" })
    return { ok: res.ok, status: res.status, items: extractMedia(res.data), nextMaxId: nextCursor(res.data) }
  } catch (e) {
    return { ok: false, status: 0, items: [], nextMaxId: null, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function fetchExplore(accountId: number): Promise<MediaResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, items: [], error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.explore(c, {})
    return { ok: res.ok, status: res.status, items: extractMedia(res.data) }
  } catch (e) {
    return { ok: false, status: 0, items: [], error: e instanceof Error ? e.message : "failed" }
  }
}

export interface StoriesResult {
  ok: boolean
  status: number
  items: ExtractedStory[]
  error?: string
}

// Stories tray for the home feed (request #7 — /feed/reels_tray/).
export async function fetchStories(accountId: number): Promise<StoriesResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, items: [], error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.reelsTray(c)
    return { ok: res.ok, status: res.status, items: extractStories(res.data) }
  } catch (e) {
    return { ok: false, status: 0, items: [], error: e instanceof Error ? e.message : "failed" }
  }
}

export async function fetchReelScroll(accountId: number, maxId?: string): Promise<MediaResult & { nextMaxId: string | null }> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, items: [], nextMaxId: null, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.reelScroll(c, { maxId: maxId || null })
    return { ok: res.ok, status: res.status, items: extractMedia(res.data), nextMaxId: nextCursor(res.data) }
  } catch (e) {
    return { ok: false, status: 0, items: [], nextMaxId: null, error: e instanceof Error ? e.message : "failed" }
  }
}

export interface ActionResult {
  ok: boolean
  status: number
  error?: string
}

export async function likeMediaAction(accountId: number, mediaId: string): Promise<ActionResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.likeMedia(c, mediaId)
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function saveMediaAction(accountId: number, mediaId: string): Promise<ActionResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.saveMedia(c, mediaId, { containerModule: "clips_viewer_clips_tab" })
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function repostMediaAction(accountId: number, mediaId: string): Promise<ActionResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.repost(c, mediaId, { containerModule: "clips_viewer_clips_tab" })
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function likeCommentAction(accountId: number, commentId: string): Promise<ActionResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.commentLike(c, commentId)
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function followAction(accountId: number, targetUserId: string, mediaId?: string): Promise<ActionResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.follow(c, targetUserId, { mediaId })
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function unfollowAction(accountId: number, targetUserId: string, mediaId?: string): Promise<ActionResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    // Mirror the real app: fire the pre-unfollow chaining-count check first.
    // It's informational, so ignore its result and proceed to the unfollow.
    await ep.unfollowChainingCount(c, targetUserId).catch(() => {})
    const res = await ep.unfollow(c, targetUserId, { mediaId })
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "failed" }
  }
}

// Runs the offensive-comment check (#17) before posting the comment (#18), per ordering.
export async function makeCommentAction(accountId: number, mediaId: string, text: string): Promise<ActionResult> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    await ep.checkOffensiveComment(c, mediaId, text)
    const res = await ep.makeComment(c, mediaId, text)
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : "failed" }
  }
}

export async function fetchComments(accountId: number, mediaId: string): Promise<{ ok: boolean; status: number; items: ExtractedComment[]; error?: string }> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, items: [], error: "Account not found" }
  const c = new InstagramClient(account)
  try {
    const res = await ep.mediaComments(c, mediaId)
    return { ok: res.ok, status: res.status, items: extractComments(res.data) }
  } catch (e) {
    return { ok: false, status: 0, items: [], error: e instanceof Error ? e.message : "failed" }
  }
}
