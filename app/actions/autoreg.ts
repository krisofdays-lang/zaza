"use server"

import { db } from "@/lib/db"
import {
  igAutoregAccounts,
  igAutoregLogs,
  igAutoregJobs,
  igAccounts,
  users,
  type IgAutoregAccount,
  type IgAutoregLog,
  type IgAutoregJob,
} from "@/lib/db/schema"
import { eq, desc, and } from "drizzle-orm"
import { requireUser } from "@/lib/auth/session"
import { revalidatePath } from "next/cache"
import { startAutoregJob, cancelAutoregJob, type AutoregJobConfig } from "@/lib/autoreg/runner"
import { randomDevice } from "@/lib/instagram/devices"
import { buildUserAgent, PINNED_IG_APP_VERSION } from "@/lib/instagram/devices"
import { randomBytes } from "node:crypto"

// ── Guard ────────────────────────────────────────────────────────────────
async function requireAdmin() {
  const user = await requireUser()
  if (!user.isAdmin) throw new Error("FORBIDDEN")
  return user
}

// ── Start registration job ───────────────────────────────────────────────

export interface StartJobInput {
  method: "email" | "sms"
  threads: number
  targetCount: number
  proxies: string[]
  anymessageApiKey?: string
  anymessageDomain?: string
  textverifiedToken?: string
  groupLabel?: string
}

export async function startAutoregAction(input: StartJobInput): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  await requireAdmin()

  if (!input.proxies.length) return { ok: false, error: "At least one proxy is required." }
  if (input.targetCount < 1) return { ok: false, error: "Target count must be at least 1." }
  if (input.threads < 1 || input.threads > 20) return { ok: false, error: "Threads must be 1-20." }

  if (input.method === "email" && !input.anymessageApiKey) {
    return { ok: false, error: "AnyMessage API key is required for email registration." }
  }
  if (input.method === "sms" && !input.textverifiedToken) {
    return { ok: false, error: "TextVerified token is required for SMS registration." }
  }

  try {
    const jobId = await startAutoregJob({
      method: input.method,
      threads: input.threads,
      targetCount: input.targetCount,
      proxies: input.proxies,
      anymessageApiKey: input.anymessageApiKey,
      anymessageDomain: input.anymessageDomain,
      textverifiedToken: input.textverifiedToken,
      groupLabel: input.groupLabel,
    })
    return { ok: true, jobId }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── Cancel job ───────────────────────────────────────────────────────────

export async function cancelAutoregAction(jobId: string): Promise<{ ok: boolean }> {
  await requireAdmin()
  await cancelAutoregJob(jobId)
  return { ok: true }
}

// ── List jobs ────────────────────────────────────────────────────────────

export async function listAutoregJobs(): Promise<IgAutoregJob[]> {
  await requireAdmin()
  return db.select().from(igAutoregJobs).orderBy(desc(igAutoregJobs.startedAt)).limit(50)
}

// ── Get current/latest job ───────────────────────────────────────────────

export async function getLatestAutoregJob(): Promise<IgAutoregJob | null> {
  await requireAdmin()
  const [job] = await db
    .select()
    .from(igAutoregJobs)
    .orderBy(desc(igAutoregJobs.startedAt))
    .limit(1)
  return job || null
}

// ── List logs for a job ──────────────────────────────────────────────────

export async function listAutoregLogs(jobId?: string): Promise<IgAutoregLog[]> {
  await requireAdmin()
  const q = jobId
    ? db.select().from(igAutoregLogs).where(eq(igAutoregLogs.jobId, jobId))
    : db.select().from(igAutoregLogs)
  return q.orderBy(desc(igAutoregLogs.startedAt)).limit(200)
}

// ── List autoreg accounts ────────────────────────────────────────────────

export async function listAutoregAccounts(): Promise<IgAutoregAccount[]> {
  await requireAdmin()
  return db.select().from(igAutoregAccounts).orderBy(desc(igAutoregAccounts.createdAt)).limit(500)
}

// ── Transfer autoreg account to a platform user ──────────────────────────
// Creates a new igAccounts row for the target user and marks the autoreg
// account as transferred.

export async function transferAutoregAccount(
  autoregAccountId: number,
  targetUserId: number,
): Promise<{ ok: boolean; accountId?: number; error?: string }> {
  await requireAdmin()

  // Validate autoreg account
  const [arAcct] = await db
    .select()
    .from(igAutoregAccounts)
    .where(eq(igAutoregAccounts.id, autoregAccountId))
    .limit(1)
  if (!arAcct) return { ok: false, error: "Autoreg account not found." }
  if (arAcct.status === "transferred") return { ok: false, error: "Account already transferred." }

  // Validate target user
  const [targetUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1)
  if (!targetUser) return { ok: false, error: "Target user not found." }

  // Pick a random device for the new platform account (using the stored device
  // profile from the autoreg run, not a fresh one)
  const sessionBlob = arAcct.sessionBlob as Record<string, any> | null

  try {
    // Create the igAccounts row
    const [newAcct] = await db
      .insert(igAccounts)
      .values({
        userId: targetUserId,
        label: arAcct.username,
        username: arAcct.username,
        password: arAcct.password,
        totpSeed: arAcct.totpSeed,
        igUserId: arAcct.igUserId,
        bearerToken: arAcct.bearerToken,
        mid: arAcct.mid,
        claim: arAcct.claim || "SKIP",
        deviceId: arAcct.deviceId,
        familyDeviceId: arAcct.familyDeviceId,
        phoneId: arAcct.phoneId,
        identity: sessionBlob,
        cloudTrustToken: arAcct.cloudTrustToken,
        proxyType: !arAcct.proxyUrl ? "none" : arAcct.proxyUrl.startsWith("socks") ? "socks5" : "http",
        proxyUrl: arAcct.proxyUrl,
        iphoneModel: arAcct.iphoneModel,
        iosVersion: arAcct.iosVersion,
        appVersion: arAcct.appVersion || PINNED_IG_APP_VERSION,
        locale: arAcct.locale,
        timezone: arAcct.timezone,
        userAgent: arAcct.userAgent,
        status: "idle",
        clockOffsetMs: Math.floor(Math.random() * 240_000) - 120_000,
        prngSeed: randomBytes(32).toString("hex"),
      })
      .returning({ id: igAccounts.id })

    // Mark autoreg account as transferred
    await db
      .update(igAutoregAccounts)
      .set({
        status: "transferred",
        transferredToUserId: targetUserId,
        transferredToAccountId: newAcct.id,
        transferredAt: new Date(),
      })
      .where(eq(igAutoregAccounts.id, autoregAccountId))

    revalidatePath("/autoreg")
    return { ok: true, accountId: newAcct.id }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── Batch transfer ───────────────────────────────────────────────────────

export async function batchTransferAutoregAccounts(
  accountIds: number[],
  targetUserId: number,
): Promise<{ ok: boolean; transferred: number; errors: string[] }> {
  await requireAdmin()
  let transferred = 0
  const errors: string[] = []
  for (const id of accountIds) {
    const result = await transferAutoregAccount(id, targetUserId)
    if (result.ok) transferred++
    else errors.push(`#${id}: ${result.error}`)
  }
  return { ok: errors.length === 0, transferred, errors }
}

// ── Delete autoreg account ───────────────────────────────────────────────

export async function deleteAutoregAccount(id: number): Promise<{ ok: boolean }> {
  await requireAdmin()
  await db.delete(igAutoregAccounts).where(eq(igAutoregAccounts.id, id))
  revalidatePath("/autoreg")
  return { ok: true }
}

// ── Export autoreg accounts ──────────────────────────────────────────────
// Format: username password 2fa(or - if none) base64 group(or - if none) proxy

export async function exportAutoregAccounts(accountIds?: number[]): Promise<string> {
  await requireAdmin()

  let accounts: IgAutoregAccount[]
  if (accountIds?.length) {
    accounts = []
    for (const id of accountIds) {
      const [a] = await db.select().from(igAutoregAccounts).where(eq(igAutoregAccounts.id, id))
      if (a) accounts.push(a)
    }
  } else {
    accounts = await db
      .select()
      .from(igAutoregAccounts)
      .where(eq(igAutoregAccounts.status, "created"))
      .orderBy(desc(igAutoregAccounts.createdAt))
  }

  const lines = accounts.map((a) => {
    const totp = a.totpSeed || "-"
    const blob = a.sessionBlob ? Buffer.from(JSON.stringify(a.sessionBlob)).toString("base64") : "-"
    const group = a.groupLabel || "-"
    const proxy = a.proxyUrl || "-"
    return `${a.username} ${a.password} ${totp} ${blob} ${group} ${proxy}`
  })

  return lines.join("\n")
}

// ── List platform users (for transfer dropdown) ──────────────────────────

export async function listPlatformUsers(): Promise<{ id: number; label: string; licenseKey: string }[]> {
  await requireAdmin()
  const rows = await db.select().from(users).orderBy(users.id)
  return rows.map((u) => ({
    id: u.id,
    label: u.label || `User #${u.id}`,
    licenseKey: u.licenseKey,
  }))
}
