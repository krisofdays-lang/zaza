"use server"

import { db } from "@/lib/db"
import { users } from "@/lib/db/schema"
import { eq, desc, count } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { requireUser } from "@/lib/auth/session"
import { igAccounts, igWorkflows, igGroups } from "@/lib/db/schema"
import { revalidatePath } from "next/cache"

// Guard: only the owner/admin may manage license keys.
async function requireAdmin() {
  const user = await requireUser()
  if (!user.isAdmin) throw new Error("FORBIDDEN")
  return user
}

export interface LicenseRow {
  id: number
  licenseKey: string
  label: string
  isAdmin: boolean
  createdAt: string
  accounts: number
  workflows: number
  groups: number
}

export async function listLicenses(): Promise<LicenseRow[]> {
  await requireAdmin()
  const rows = await db.select().from(users).orderBy(desc(users.id))

  // Per-user counts for the admin table. Small N (license holders), so a few
  // grouped counts are fine.
  const [acc, wf, grp] = await Promise.all([
    db.select({ userId: igAccounts.userId, n: count() }).from(igAccounts).groupBy(igAccounts.userId),
    db.select({ userId: igWorkflows.userId, n: count() }).from(igWorkflows).groupBy(igWorkflows.userId),
    db.select({ userId: igGroups.userId, n: count() }).from(igGroups).groupBy(igGroups.userId),
  ])
  const accMap = new Map(acc.map((r) => [r.userId, r.n]))
  const wfMap = new Map(wf.map((r) => [r.userId, r.n]))
  const grpMap = new Map(grp.map((r) => [r.userId, r.n]))

  return rows.map((u) => ({
    id: u.id,
    licenseKey: u.licenseKey,
    label: u.label,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt.toISOString(),
    accounts: accMap.get(u.id) ?? 0,
    workflows: wfMap.get(u.id) ?? 0,
    groups: grpMap.get(u.id) ?? 0,
  }))
}

// Generate a fresh license key (UUID) and insert a non-admin user.
export async function createLicense(label: string): Promise<{ ok: boolean; licenseKey?: string; error?: string }> {
  await requireAdmin()
  const licenseKey = randomUUID()
  try {
    await db.insert(users).values({ licenseKey, label: label.trim().slice(0, 80), isAdmin: false })
  } catch {
    return { ok: false, error: "Could not create license." }
  }
  revalidatePath("/admin")
  return { ok: true, licenseKey }
}

// Revoke (delete) a license. Admin accounts cannot be revoked from the UI to
// avoid locking the owner out. All of the user's data is removed with them.
export async function revokeLicense(id: number): Promise<{ ok: boolean; error?: string }> {
  const me = await requireAdmin()
  if (id === me.id) return { ok: false, error: "You cannot revoke your own license." }

  const [target] = await db.select().from(users).where(eq(users.id, id))
  if (!target) return { ok: true }
  if (target.isAdmin) return { ok: false, error: "Admin licenses cannot be revoked here." }

  await db.delete(users).where(eq(users.id, id))
  revalidatePath("/admin")
  return { ok: true }
}
