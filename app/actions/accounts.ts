"use server"

import { randomBytes } from "node:crypto"
import { after } from "next/server"
import { db } from "@/lib/db"
import {
  igAccounts,
  igRunLogs,
  igWorkflows,
  igWarmupJobs,
  igPublications,
  igGroups,
  igGroupAccounts,
  igFollowClaims,
  igAnalyticsJobs,
  igMedia,
  type NewIgAccount,
} from "@/lib/db/schema"
import { eq, and, desc, inArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { requireUserId } from "@/lib/auth/session"
import { InstagramClient, decodeBearer } from "@/lib/instagram/client"
import { PINNED_IG_APP_VERSION, normalizeLocale, DEFAULT_TIMEZONE } from "@/lib/instagram/devices"
import { decodeCookieBlob, buildUserAgentFromBlob, iosUnderscoreFromBlob } from "@/lib/instagram/cookie-blob"
import { getAction } from "@/lib/instagram/actions"
import { extractProfileUser, extractMedia } from "@/lib/instagram/parse"
import { deleteLocalMedia, relPathFromUrl } from "@/lib/media/storage"
import { classifyResponse } from "@/lib/instagram/status-classify"

// Sum the play counts of an account's 6 most recent reels. profileReels streams
// the initial 6 medias, which is exactly the window we want. Best-effort: any
// failure returns null so it never blocks adding/refreshing an account.
async function recentReelViewsSafe(client: InstagramClient, userId: string): Promise<number | null> {
  try {
    const { profileReels } = await import("@/lib/instagram/endpoints")
    const res = await profileReels(client, userId, null)
    if (!res.ok) return null
    const reels = extractMedia(res.data).slice(0, 6)
    if (!reels.length) return null
    return reels.reduce((sum, r) => sum + (r.viewCount ?? 0), 0)
  } catch {
    return null
  }
}

export async function getAccounts() {
  const userId = await requireUserId()
  return db.select().from(igAccounts).where(eq(igAccounts.userId, userId)).orderBy(desc(igAccounts.createdAt))
}

// Lightweight version for page rendering — excludes heavy columns that the UI
// never displays (identity jsonb blob, bearerToken, password, etc.). With 50+
// accounts the full select() produces a multi-MB RSC payload that freezes the
// browser; this cuts it to a few KB per row.
export async function getAccountsForDisplay() {
  const userId = await requireUserId()
  return db
    .select({
      id: igAccounts.id,
      userId: igAccounts.userId,
      label: igAccounts.label,
      username: igAccounts.username,
      igUserId: igAccounts.igUserId,
      proxyType: igAccounts.proxyType,
      proxyUrl: igAccounts.proxyUrl,
      rotationUrl: igAccounts.rotationUrl,
      iphoneModel: igAccounts.iphoneModel,
      iosVersion: igAccounts.iosVersion,
      appVersion: igAccounts.appVersion,
      locale: igAccounts.locale,
      timezone: igAccounts.timezone,
      status: igAccounts.status,
      lastError: igAccounts.lastError,
      profile: igAccounts.profile,
      recentReelViews: igAccounts.recentReelViews,
      lastCheckedAt: igAccounts.lastCheckedAt,
      lastPostAt: igAccounts.lastPostAt,
      createdAt: igAccounts.createdAt,
    })
    .from(igAccounts)
    .where(eq(igAccounts.userId, userId))
    .orderBy(desc(igAccounts.createdAt))
}

// The row shape returned by getAccountsForDisplay — everything the UI needs
// without the heavy auth/identity blobs that bloat the RSC payload.
export type DisplayAccount = Awaited<ReturnType<typeof getAccountsForDisplay>>[number]

// Ultra-lightweight status-only query for client-side polling. Returns only the
// fields that can change asynchronously (after refresh / create) so the UI can
// update status badges, avatars and usernames without a full page refresh.
export async function getAccountStatuses() {
  const userId = await requireUserId()
  return db
    .select({
      id: igAccounts.id,
      status: igAccounts.status,
      username: igAccounts.username,
      profile: igAccounts.profile,
      recentReelViews: igAccounts.recentReelViews,
      lastError: igAccounts.lastError,
      lastCheckedAt: igAccounts.lastCheckedAt,
    })
    .from(igAccounts)
    .where(eq(igAccounts.userId, userId))
}

export type AccountStatus = Awaited<ReturnType<typeof getAccountStatuses>>[number]

export async function getAccount(id: number) {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(igAccounts)
    .where(and(eq(igAccounts.id, id), eq(igAccounts.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

// Rotate the proxy IP for an account by hitting its rotation link. Used to gate
// opening the phone: we only let requests flow once rotation succeeds. When the
// account has no rotation URL this is a no-op that reports success.
export async function rotateAccountProxy(
  accountId: number,
): Promise<{ ok: boolean; rotated: boolean; status: number; error?: string }> {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, rotated: false, status: 0, error: "Account not found" }
  const client = new InstagramClient(account)
  return client.rotateProxy()
}

export async function createAccount(input: {
  username?: string
  password?: string
  twofa?: string
  // Base64-encoded cookie blob captured from a real device. REQUIRED for now:
  // login by username/password is not implemented yet, so an account cannot be
  // added without it.
  cookie: string
  proxyType: string
  proxyUrl?: string
  rotationUrl?: string
  // Optional group(s) to drop the new account into right away.
  groupIds?: number[]
  }) {
  const userId = await requireUserId()

  // Decode the cookie blob. Throws on empty/invalid input so the caller blocks
  // the add and shows the reason. Everything below is taken VERBATIM from the
  // blob — we never synthesize device identifiers.
  const blob = decodeCookieBlob(input.cookie)
  const session = blob.session ?? {}
  const device = blob.device ?? {}
  const ua = blob.ua_profile ?? {}

  const bearerToken = (session.authorization ?? "").trim()
  const decoded = decodeBearer(bearerToken)
  const igUserId = (session.ds_user_id != null ? String(session.ds_user_id) : "") || decoded.dsUserId

  // Region + device come straight from the capture. The iPhone model / iOS are
  // whatever the real device reported (e.g. iPhone10,6 / 16_4_1) — NOT clamped
  // to our iOS 17+ preset table. Only the IG app version is forced to ours.
  const locale = normalizeLocale(ua.locale)
  const timezone = (ua.tz_name ?? "").trim() || DEFAULT_TIMEZONE
  const iphoneModel = (ua.device_model ?? "").trim() || "iPhone11,8"
  const iosVersion = iosUnderscoreFromBlob(blob) || "17_0"
  const userAgent = buildUserAgentFromBlob(blob)

  const values: NewIgAccount = {
    userId,
    label: input.username?.trim() || blob.username || "Account",
    username: input.username?.trim() || blob.username || "",
    password: input.password?.trim() || blob.password || "",
    totpSeed: input.twofa?.trim() || blob.totp_seed || "",
    igUserId,
    bearerToken,
    mid: (session.mid ?? "").trim(),
    claim: (session.www_claim ?? "").trim() || "SKIP",
    // Real device identity from the blob: guid -> deviceId (_uuid),
    // family_device_id -> familyDeviceId, phone_id -> phoneId.
    deviceId: (device.guid ?? "").trim(),
    familyDeviceId: (device.family_device_id ?? "").trim(),
    phoneId: (device.phone_id ?? "").trim(),
    cloudTrustToken: (device.cloud_trust ?? "").trim(),
    identity: blob,
    proxyType: input.proxyType,
    proxyUrl: input.proxyUrl?.trim() ?? "",
    rotationUrl: input.rotationUrl?.trim() ?? "",
    iphoneModel,
    iosVersion,
    // Stored for display/bookkeeping only — the wire app version is always the
    // pinned latest build (see PINNED_IG_APP_VERSION / the client).
    appVersion: PINNED_IG_APP_VERSION,
    locale,
    timezone,
    userAgent,
    // Anti-fingerprint: per-account virtual clock offset (±120 s) and PRNG seed.
    // Every client-facing timestamp and random ID is derived from these so
    // parallel accounts look like separate phones with independent clocks.
    clockOffsetMs: Math.floor(Math.random() * 240_000) - 120_000,
    prngSeed: randomBytes(32).toString("hex"),
  }
  const [row] = await db.insert(igAccounts).values(values).returning()

  // Assign to any requested group(s) immediately (only groups owned by the user).
  if (input.groupIds?.length) {
    const owned = await db.select({ id: igGroups.id }).from(igGroups).where(eq(igGroups.userId, userId))
    const ownedIds = new Set(owned.map((g) => g.id))
    const toAdd = [...new Set(input.groupIds)].filter((g) => ownedIds.has(g))
    if (toAdd.length) {
      await db.insert(igGroupAccounts).values(toAdd.map((groupId) => ({ groupId, accountId: row.id })))
      revalidatePath("/groups")
    }
  }

  // Pull the live profile in the background — the account row is returned to the
  // UI immediately. The profile will appear on the next revalidation/poll.
  after(async () => {
    try {
      const client = new InstagramClient(row)
      await client.rotateProxy().catch(() => {})
      const res = await profileInfoSafe(client, row.igUserId || client.uid)
      const user = res.ok ? extractProfileUser(res.data) : null
      if (user) {
        const resolvedId = user.pk != null ? String(user.pk) : row.igUserId
        const reelViews = await recentReelViewsSafe(client, resolvedId || client.uid)
        await db
          .update(igAccounts)
          .set({
            profile: user,
            username: (user.username as string) || row.username,
            igUserId: resolvedId,
            recentReelViews: reelViews,
            status: "ok",
            lastCheckedAt: new Date(),
            lastError: "",
          })
          .where(eq(igAccounts.id, row.id))
      }
      // Invalidate cache so the next client poll picks up the fresh profile/avatar.
      revalidatePath("/")
      revalidatePath("/dashboard")
    } catch {
      // ignore — the account is added; the profile can be refreshed later.
    }
  })

  revalidatePath("/")
  revalidatePath("/dashboard")
  return row
}

export async function updateAccount(id: number, input: Partial<NewIgAccount>) {
  const userId = await requireUserId()
  await db.update(igAccounts).set(input).where(and(eq(igAccounts.id, id), eq(igAccounts.userId, userId)))
  revalidatePath("/")
  revalidatePath("/dashboard")
  revalidatePath(`/accounts/${id}`)
}

// Edit an account from the UI. Always updates the credentials (username /
// password / 2FA) and proxy. When a NEW cookie blob is pasted, the entire
// device + session identity is re-decoded and replaced verbatim; when the
// cookie field is left blank the existing identity is kept untouched.
export async function editAccount(
  id: number,
  input: {
    username?: string
    password?: string
    twofa?: string
    // Optional on edit: blank = keep the existing decoded identity.
    cookie?: string
    proxyType: string
    proxyUrl?: string
    rotationUrl?: string
  },
) {
  const acc = await getAccount(id)
  if (!acc) throw new Error("Account not found")

  const patch: Partial<NewIgAccount> = {
    proxyType: input.proxyType,
    proxyUrl: input.proxyUrl?.trim() ?? "",
    rotationUrl: input.rotationUrl?.trim() ?? "",
    username: input.username?.trim() || acc.username,
    label: input.username?.trim() || acc.label,
    password: input.password?.trim() || acc.password,
    totpSeed: input.twofa?.trim() || acc.totpSeed,
  }

  const cookie = input.cookie?.trim()
  if (cookie) {
    // Re-decode and replace the whole identity verbatim.
    const blob = decodeCookieBlob(cookie)
    const session = blob.session ?? {}
    const device = blob.device ?? {}
    const ua = blob.ua_profile ?? {}
    const bearerToken = (session.authorization ?? "").trim()
    const decoded = decodeBearer(bearerToken)

    patch.igUserId = (session.ds_user_id != null ? String(session.ds_user_id) : "") || decoded.dsUserId
    patch.bearerToken = bearerToken
    patch.mid = (session.mid ?? "").trim()
    patch.claim = (session.www_claim ?? "").trim() || "SKIP"
    patch.deviceId = (device.guid ?? "").trim()
    patch.familyDeviceId = (device.family_device_id ?? "").trim()
    patch.phoneId = (device.phone_id ?? "").trim()
    patch.cloudTrustToken = (device.cloud_trust ?? "").trim()
    patch.identity = blob
    patch.iphoneModel = (ua.device_model ?? "").trim() || acc.iphoneModel
    patch.iosVersion = iosUnderscoreFromBlob(blob) || acc.iosVersion
    patch.locale = normalizeLocale(ua.locale)
    patch.timezone = (ua.tz_name ?? "").trim() || DEFAULT_TIMEZONE
    patch.appVersion = PINNED_IG_APP_VERSION
    patch.userAgent = buildUserAgentFromBlob(blob)
    // Credentials embedded in the new blob win only when the form left them blank.
    if (!input.username?.trim() && blob.username) patch.username = blob.username
    if (!input.password?.trim() && blob.password) patch.password = blob.password
    if (!input.twofa?.trim() && blob.totp_seed) patch.totpSeed = blob.totp_seed
  }

  await db.update(igAccounts).set(patch).where(eq(igAccounts.id, id))
  revalidatePath("/")
  revalidatePath("/dashboard")
  revalidatePath(`/accounts/${id}`)
}

// Fully remove an account and everything that references it: its stored media
// (rows + files on disk), group memberships, follow-claim rows, run logs, and
// its id inside every jsonb account list (workflows, publications, warmup and
// analytics jobs). Everything is scoped to the current user so one user can
// never affect another's data.
//
// The account row is deleted IMMEDIATELY so the UI updates instantly. All heavy
// cleanup (media files, jsonb patching, run logs) runs in after() — the response
// is sent before that work starts.
export async function deleteAccount(id: number) {
  const userId = await requireUserId()

  // Guard: only proceed if the account belongs to this user.
  const owned = await db
    .select({ id: igAccounts.id })
    .from(igAccounts)
    .where(and(eq(igAccounts.id, id), eq(igAccounts.userId, userId)))
    .limit(1)
  if (!owned[0]) return { ok: false, error: "Not found" }

  // Delete the account row right away — FK-referenced rows with ON DELETE
  // CASCADE are handled by the DB; the rest is cleaned up in after().
  // Also delete direct-reference rows that have no cascade (fast, index-only).
  await Promise.all([
    db.delete(igAccounts).where(and(eq(igAccounts.id, id), eq(igAccounts.userId, userId))),
    db.delete(igGroupAccounts).where(eq(igGroupAccounts.accountId, id)),
    db.delete(igFollowClaims).where(eq(igFollowClaims.accountId, id)),
    db.delete(igRunLogs).where(and(eq(igRunLogs.userId, userId), eq(igRunLogs.accountId, id))),
  ])

  revalidatePath("/")
  revalidatePath("/dashboard")
  revalidatePath("/storage")
  revalidatePath("/workflows")
  revalidatePath("/groups")

  // Heavy cleanup runs AFTER the response is sent — the user doesn't wait.
  after(async () => {
    try {
      // 1) Media files on disk + rows.
      const media = await db
        .select()
        .from(igMedia)
        .where(and(eq(igMedia.userId, userId), eq(igMedia.usedByAccountId, id)))
      await Promise.all(
        media.map((m) => {
          const rel = m.pathname || relPathFromUrl(m.blobUrl)
          return rel ? deleteLocalMedia(rel).catch(() => {}) : Promise.resolve()
        }),
      )
      if (media.length) {
        await db.delete(igMedia).where(
          and(
            eq(igMedia.userId, userId),
            inArray(
              igMedia.id,
              media.map((m) => m.id),
            ),
          ),
        )
      }

      // 2) jsonb account lists: pull rows for this user, drop the id, write
      //    back only the rows that actually changed.
      const [workflows, publications, warmups, analytics] = await Promise.all([
        db.select().from(igWorkflows).where(eq(igWorkflows.userId, userId)),
        db.select().from(igPublications).where(eq(igPublications.userId, userId)),
        db.select().from(igWarmupJobs).where(eq(igWarmupJobs.userId, userId)),
        db.select().from(igAnalyticsJobs).where(eq(igAnalyticsJobs.userId, userId)),
      ])

      const without = (arr: unknown): number[] =>
        Array.isArray(arr) ? (arr as number[]).filter((n) => Number(n) !== id) : []
      const includesId = (arr: unknown): boolean =>
        Array.isArray(arr) && (arr as number[]).some((n) => Number(n) === id)

      await Promise.all([
        ...workflows
          .filter((w) => includesId(w.accountIds))
          .map((w) =>
            db.update(igWorkflows).set({ accountIds: without(w.accountIds) }).where(eq(igWorkflows.id, w.id)),
          ),
        ...publications
          .filter((p) => {
            const assignments = Array.isArray(p.assignments)
              ? (p.assignments as { accountId?: number }[]).some((a) => Number(a?.accountId) === id)
              : false
            return includesId(p.accountIds) || assignments
          })
          .map((p) => {
            const assignments = Array.isArray(p.assignments)
              ? (p.assignments as { accountId?: number }[]).filter((a) => Number(a?.accountId) !== id)
              : []
            return db
              .update(igPublications)
              .set({ accountIds: without(p.accountIds), assignments })
              .where(eq(igPublications.id, p.id))
          }),
        ...warmups
          .filter((w) => includesId(w.accountIds))
          .map((w) =>
            db.update(igWarmupJobs).set({ accountIds: without(w.accountIds) }).where(eq(igWarmupJobs.id, w.id)),
          ),
        ...analytics
          .filter((a) => includesId(a.accountIds))
          .map((a) =>
            db
              .update(igAnalyticsJobs)
              .set({ accountIds: without(a.accountIds) })
              .where(eq(igAnalyticsJobs.id, a.id)),
          ),
      ])
    } catch (e) {
      console.error(`[deleteAccount] after() cleanup failed for account ${id}:`, e)
    }
  })

  return { ok: true }
}

// Bulk-delete multiple accounts in a SINGLE request. This is important because
// individual fire-and-forget calls can be aborted by the browser when the user
// navigates away. A single request delivers all IDs reliably.
export async function bulkDeleteAccounts(ids: number[]) {
  if (!ids.length) return { ok: true, deleted: 0 }
  const userId = await requireUserId()

  // Delete all account rows + direct FK refs in one go.
  await Promise.all([
    db.delete(igAccounts).where(and(inArray(igAccounts.id, ids), eq(igAccounts.userId, userId))),
    db.delete(igGroupAccounts).where(inArray(igGroupAccounts.accountId, ids)),
    db.delete(igFollowClaims).where(inArray(igFollowClaims.accountId, ids)),
    db.delete(igRunLogs).where(and(eq(igRunLogs.userId, userId), inArray(igRunLogs.accountId, ids))),
  ])

  revalidatePath("/")
  revalidatePath("/dashboard")
  revalidatePath("/storage")
  revalidatePath("/workflows")
  revalidatePath("/groups")

  // Heavy cleanup (media files, jsonb arrays) runs AFTER the response.
  after(async () => {
    try {
      for (const id of ids) {
        const media = await db
          .select()
          .from(igMedia)
          .where(and(eq(igMedia.userId, userId), eq(igMedia.usedByAccountId, id)))
        await Promise.all(
          media.map((m) => {
            const rel = m.pathname || relPathFromUrl(m.blobUrl)
            return rel ? deleteLocalMedia(rel).catch(() => {}) : Promise.resolve()
          }),
        )
        if (media.length) {
          await db.delete(igMedia).where(
            and(
              eq(igMedia.userId, userId),
              inArray(
                igMedia.id,
                media.map((m) => m.id),
              ),
            ),
          )
        }
      }

      // jsonb arrays: pull rows, drop all deleted ids, write back changed rows.
      const [workflows, publications, warmups, analytics] = await Promise.all([
        db.select().from(igWorkflows).where(eq(igWorkflows.userId, userId)),
        db.select().from(igPublications).where(eq(igPublications.userId, userId)),
        db.select().from(igWarmupJobs).where(eq(igWarmupJobs.userId, userId)),
        db.select().from(igAnalyticsJobs).where(eq(igAnalyticsJobs.userId, userId)),
      ])

      const idSet = new Set(ids)
      const without = (arr: unknown): number[] =>
        Array.isArray(arr) ? (arr as number[]).filter((n) => !idSet.has(Number(n))) : []
      const includesAny = (arr: unknown): boolean =>
        Array.isArray(arr) && (arr as number[]).some((n) => idSet.has(Number(n)))

      await Promise.all([
        ...workflows
          .filter((w) => includesAny(w.accountIds))
          .map((w) =>
            db.update(igWorkflows).set({ accountIds: without(w.accountIds) }).where(eq(igWorkflows.id, w.id)),
          ),
        ...publications
          .filter((p) => {
            const assignments = Array.isArray(p.assignments)
              ? (p.assignments as { accountId?: number }[]).some((a) => idSet.has(Number(a?.accountId)))
              : false
            return includesAny(p.accountIds) || assignments
          })
          .map((p) => {
            const assignments = Array.isArray(p.assignments)
              ? (p.assignments as { accountId?: number }[]).filter((a) => !idSet.has(Number(a?.accountId)))
              : []
            return db
              .update(igPublications)
              .set({ accountIds: without(p.accountIds), assignments })
              .where(eq(igPublications.id, p.id))
          }),
        ...warmups
          .filter((w) => includesAny(w.accountIds))
          .map((w) =>
            db.update(igWarmupJobs).set({ accountIds: without(w.accountIds) }).where(eq(igWarmupJobs.id, w.id)),
          ),
        ...analytics
          .filter((a) => includesAny(a.accountIds))
          .map((a) =>
            db
              .update(igAnalyticsJobs)
              .set({ accountIds: without(a.accountIds) })
              .where(eq(igAnalyticsJobs.id, a.id)),
          ),
      ])
    } catch (e) {
      console.error(`[bulkDeleteAccounts] after() cleanup failed for ids ${ids.join(",")}:`, e)
    }
  })

  return { ok: true, deleted: ids.length }
}

// Bulk-refresh profiles in a SINGLE request — same reason as bulkDeleteAccounts:
// one fetch can't be partially aborted.
export async function bulkRefreshAccounts(ids: number[]) {
  if (!ids.length) return { ok: true }
  const userId = await requireUserId()

  after(async () => {
    for (const id of ids) {
      try {
        const account = await db
          .select()
          .from(igAccounts)
          .where(and(eq(igAccounts.id, id), eq(igAccounts.userId, userId)))
          .limit(1)
          .then((r) => r[0])
        if (!account) continue

        const client = new InstagramClient(account)
        const igUid = account.igUserId || ""
        if (!igUid) continue

        const { profileInfo } = await import("@/lib/instagram/endpoints")
        const res = await profileInfo(client, igUid)
        if (!res.ok) {
          const cls = classifyResponse(res.status, res.data)
          await db
            .update(igAccounts)
            .set({ status: cls.status, lastError: cls.detail || `HTTP ${res.status}`, lastCheckedAt: new Date() })
            .where(eq(igAccounts.id, id))
          continue
        }

        const profile = extractProfileUser(res.data)
        const views = await recentReelViewsSafe(client, igUid)
        const update: Record<string, unknown> = {
          username: profile?.username || account.username,
          profile,
          status: "ok",
          lastError: "",
          lastCheckedAt: new Date(),
        }
        if (views !== null) update.recentReelViews = views
        if (profile?.latest_reel_media) {
          update.lastPostAt = new Date(Number(profile.latest_reel_media) * 1000)
        }
        await db.update(igAccounts).set(update).where(eq(igAccounts.id, id))
      } catch (e) {
        console.error(`[bulkRefreshAccounts] failed for id ${id}:`, e)
        await db
          .update(igAccounts)
          .set({ status: "error", lastCheckedAt: new Date(), lastError: "Refresh failed" })
          .where(eq(igAccounts.id, id))
          .catch(() => {})
      }
    }
    revalidatePath("/")
    revalidatePath("/dashboard")
  })

  return { ok: true }
}

// Run a single action against an account and persist a log entry.
export async function runAction(accountId: number, actionKey: string, params: Record<string, string> = {}) {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, status: 0, error: "Account not found" }
  const action = getAction(actionKey)
  if (!action) return { ok: false, status: 0, error: "Unknown action" }

  const client = new InstagramClient(account)
  await client.rotateProxy()

  try {
    const res = await action.run(client, params, account)
    await db.insert(igRunLogs).values({
      userId: account.userId,
      accountId,
      action: actionKey,
      status: res.ok ? "ok" : "error",
      requestUrl: res.url,
      responseCode: res.status,
      message: res.ok ? "Success" : typeof res.data === "string" ? res.data.slice(0, 500) : JSON.stringify(res.data).slice(0, 500),
    })
    await db
      .update(igAccounts)
      .set({ status: res.ok ? "ok" : "error", lastCheckedAt: new Date(), lastError: res.ok ? "" : `HTTP ${res.status}` })
      .where(eq(igAccounts.id, accountId))
    revalidatePath(`/accounts/${accountId}`)
    return { ok: res.ok, status: res.status, data: res.data, url: res.url }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Request failed"
    await db.insert(igRunLogs).values({
      userId: account.userId,
      accountId,
      action: actionKey,
      status: "error",
      message: message.slice(0, 500),
    })
    await db.update(igAccounts).set({ status: "error", lastError: message.slice(0, 200) }).where(eq(igAccounts.id, accountId))
    revalidatePath(`/accounts/${accountId}`)
    return { ok: false, status: 0, error: message }
  }
}

// Fetch and cache the profile info for an account (refreshes the card).
// Returns immediately — the actual Instagram API call runs in after() so the
// UI never blocks. The DB row is updated when the fetch completes and a
// subsequent revalidation picks it up automatically.
export async function refreshAccountProfile(accountId: number) {
  const account = await getAccount(accountId)
  if (!account) return { ok: false, error: "Account not found" }

  after(async () => {
    try {
      const client = new InstagramClient(account)
      // NOTE: do NOT rotate the proxy here. A manual refresh is a read-only
      // profile fetch, and the iPhone view (fetchProfile) hits the exact same
      // info_stream endpoint WITHOUT rotating and works fine.
      let res = await profileInfoSafe(client, account.igUserId || client.uid)
      let user = res.ok ? extractProfileUser(res.data) : null
      // Instagram occasionally returns a lightweight "prefetch" 200 chunk that
      // omits the user on the first hit; one retry usually returns the full object.
      if (!user && res.status >= 200 && res.status < 300) {
        res = await profileInfoSafe(client, account.igUserId || client.uid)
        user = res.ok ? extractProfileUser(res.data) : null
      }
      if (user) {
        const resolvedId = user.pk != null ? String(user.pk) : account.igUserId
        const reelViews = await recentReelViewsSafe(client, resolvedId || client.uid)
        await db
          .update(igAccounts)
          .set({
            status: "ok",
            lastCheckedAt: new Date(),
            lastError: "",
            profile: user,
            username: (user.username as string) || account.username,
            igUserId: resolvedId,
            recentReelViews: reelViews,
          })
          .where(eq(igAccounts.id, accountId))
      } else {
        const classified = classifyResponse(res.status, res.data)
        const patch: Record<string, unknown> = {
          status: classified.status === "ok" ? "error" : classified.status,
          lastCheckedAt: new Date(),
          lastError: classified.detail || `HTTP ${res.status}`,
        }
        if (classified.status === "checkpoint") {
          const prev =
            (account.challengeState as { challengeRootId?: string; challengeContext?: string } | null) ?? null
          if (!prev?.challengeRootId) {
            const { extractChallengeIds } = await import("@/lib/instagram/status-classify")
            const { rootId, context } = extractChallengeIds(res.data)
            if (rootId) {
              patch.challengeState = {
                challengeRootId: rootId,
                challengeContext: context ?? prev?.challengeContext,
                step: "intro",
              }
            }
          }
        }
        await db.update(igAccounts).set(patch).where(eq(igAccounts.id, accountId))
      }
      // Invalidate the server cache so the next client poll or navigation sees
      // the freshly-fetched profile, status and avatar.
      revalidatePath("/")
      revalidatePath("/dashboard")
    } catch (e) {
      console.error(`[refreshAccountProfile] after() failed for account ${accountId}:`, e)
      await db
        .update(igAccounts)
        .set({ status: "error", lastCheckedAt: new Date(), lastError: "Refresh failed" })
        .where(eq(igAccounts.id, accountId))
        .catch(() => {})
      revalidatePath("/")
      revalidatePath("/dashboard")
    }
  })

  revalidatePath(`/accounts/${accountId}`)
  revalidatePath("/")
  revalidatePath("/dashboard")
  return { ok: true, status: 0, accountStatus: "ok" as const, detail: "" }
}

async function profileInfoSafe(client: InstagramClient, userId: string) {
  const { profileInfo } = await import("@/lib/instagram/endpoints")
  try {
    return await profileInfo(client, userId)
  } catch (e) {
    return { ok: false, status: 0, data: { error: e instanceof Error ? e.message : "failed" }, url: "" }
  }
}

export async function getRecentLogs(limit = 50) {
  const userId = await requireUserId()
  return db
    .select()
    .from(igRunLogs)
    .where(eq(igRunLogs.userId, userId))
    .orderBy(desc(igRunLogs.createdAt))
    .limit(limit)
}

// Live activity feed for the dashboard. Active Jobs lists every running/queued
// QUEUE (workflows, warm up jobs and publications), while Accounts Activity is
// the per-account run-log history. Returns wire-safe rows (dates as ISO
// strings) so a client component can poll this without re-deriving maps.
export type DashboardActivity = {
  activeJobs: {
    id: string // unique across kinds, e.g. "wf-12", "wu-3", "pub-5"
    kind: "workflow" | "warmup" | "publication"
    title: string // queue name / type
    subtitle: string // current account or phase
    status: string // queued | running
    processed: number
    total: number
  }[]
  recentJobs: {
    id: number
    username: string
    action: string
    status: string
    message: string
    whenISO: string
  }[]
}

const WARMUP_KIND_LABELS: Record<string, string> = {
  feed_scroll: "Feed Scroll",
  reels_scroll: "Reels Scroll",
  feed_training: "Feed Training",
  stories_tracker: "Stories Tracker",
}

export async function getDashboardActivity(): Promise<DashboardActivity> {
  const userId = await requireUserId()
  const [accounts, logs, workflows, warmups, publications] = await Promise.all([
    db.select().from(igAccounts).where(eq(igAccounts.userId, userId)),
    db.select().from(igRunLogs).where(eq(igRunLogs.userId, userId)).orderBy(desc(igRunLogs.createdAt)).limit(40),
    db
      .select()
      .from(igWorkflows)
      .where(and(eq(igWorkflows.userId, userId), eq(igWorkflows.status, "running")))
      .orderBy(desc(igWorkflows.startedAt)),
    db
      .select()
      .from(igWarmupJobs)
      .where(and(eq(igWarmupJobs.userId, userId), inArray(igWarmupJobs.status, ["queued", "running"])))
      .orderBy(desc(igWarmupJobs.startedAt)),
    db
      .select()
      .from(igPublications)
      .where(and(eq(igPublications.userId, userId), eq(igPublications.status, "running")))
      .orderBy(desc(igPublications.createdAt)),
  ])

  const nameById = new Map<number, string>()
  for (const a of accounts) nameById.set(a.id, a.username || a.label || `Account ${a.id}`)

  const activeJobs: DashboardActivity["activeJobs"] = []

  for (const w of workflows) {
    activeJobs.push({
      id: `wf-${w.id}`,
      kind: "workflow",
      title: w.name || "Workflow",
      subtitle: w.currentLabel || w.phase || "Running…",
      status: w.status,
      processed: w.processed,
      total: w.total,
    })
  }

  for (const j of warmups) {
    activeJobs.push({
      id: `wu-${j.id}`,
      kind: "warmup",
      title: `Warm up · ${WARMUP_KIND_LABELS[j.kind] ?? j.kind}`,
      subtitle: j.status === "queued" ? "Queued…" : j.currentLabel || j.phase || "Running…",
      status: j.status,
      processed: j.processed,
      total: j.total,
    })
  }

  for (const p of publications) {
    const accountIds = Array.isArray(p.accountIds) ? (p.accountIds as number[]) : []
    activeJobs.push({
      id: `pub-${p.id}`,
      kind: "publication",
      title: `Publication · ${p.type.charAt(0).toUpperCase()}${p.type.slice(1)}`,
      subtitle: accountIds.length === 1 ? nameById.get(accountIds[0]) ?? "1 account" : `${accountIds.length} accounts`,
      status: p.status,
      processed: 0,
      total: accountIds.length,
    })
  }

  const recentJobs = logs.slice(0, 14).map((l) => ({
    id: l.id,
    username: l.accountId ? nameById.get(l.accountId) ?? "Account" : "System",
    action: l.action,
    status: l.status,
    message: l.message || (l.status === "ok" ? "Completed successfully" : ""),
    whenISO: l.createdAt.toISOString(),
  }))

  return { activeJobs, recentJobs }
}

// Clear the run log history shown in the dashboard's Recent Jobs panel.
export async function clearLogs() {
  const userId = await requireUserId()
  await db.delete(igRunLogs).where(eq(igRunLogs.userId, userId))
  revalidatePath("/dashboard")
  return { ok: true }
}

export async function getAccountLogs(accountId: number, limit = 30) {
  const userId = await requireUserId()
  return db
    .select()
    .from(igRunLogs)
    .where(and(eq(igRunLogs.accountId, accountId), eq(igRunLogs.userId, userId)))
    .orderBy(desc(igRunLogs.createdAt))
    .limit(limit)
}
