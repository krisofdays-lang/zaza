"use server"

import { db } from "@/lib/db"
import { igGroups, igGroupAccounts, igAccounts, igRunLogs } from "@/lib/db/schema"
import { eq, and, desc, inArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { requireUserId } from "@/lib/auth/session"
import { InstagramClient } from "@/lib/instagram/client"
import { getAction, type WorkflowStep } from "@/lib/instagram/actions"

export async function getGroups() {
  const userId = await requireUserId()
  const groups = await db.select().from(igGroups).where(eq(igGroups.userId, userId)).orderBy(desc(igGroups.createdAt))
  const memberships = await db.select().from(igGroupAccounts)
  return groups.map((g) => ({
    ...g,
    accountIds: memberships.filter((m) => m.groupId === g.id).map((m) => m.accountId),
  }))
}

export async function getGroup(id: number) {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(igGroups)
    .where(and(eq(igGroups.id, id), eq(igGroups.userId, userId)))
    .limit(1)
  const group = rows[0]
  if (!group) return null
  const memberships = await db.select().from(igGroupAccounts).where(eq(igGroupAccounts.groupId, id))
  const accountIds = memberships.map((m) => m.accountId)
  const accounts = accountIds.length
    ? await db.select().from(igAccounts).where(inArray(igAccounts.id, accountIds))
    : []
  return { ...group, accountIds, accounts }
}

export async function createGroup(name: string, description: string, accountIds: number[] = []) {
  const userId = await requireUserId()
  const [row] = await db.insert(igGroups).values({ userId, name, description }).returning()
  if (accountIds.length) {
    await db.insert(igGroupAccounts).values(accountIds.map((accountId) => ({ groupId: row.id, accountId })))
  }
  revalidatePath("/groups")
  revalidatePath("/")
  return row
}

// Add an account into one or more groups, skipping memberships that already exist.
export async function addAccountToGroups(accountId: number, groupIds: number[]) {
  const userId = await requireUserId()
  if (groupIds.length) {
    // Only allow groups owned by the user.
    const owned = await db.select({ id: igGroups.id }).from(igGroups).where(eq(igGroups.userId, userId))
    const ownedIds = new Set(owned.map((g) => g.id))
    const allowed = groupIds.filter((g) => ownedIds.has(g))
    const existing = await db.select().from(igGroupAccounts).where(eq(igGroupAccounts.accountId, accountId))
    const have = new Set(existing.map((m) => m.groupId))
    const toAdd = allowed.filter((g) => !have.has(g))
    if (toAdd.length) {
      await db.insert(igGroupAccounts).values(toAdd.map((groupId) => ({ groupId, accountId })))
    }
  }
  revalidatePath("/groups")
  revalidatePath("/")
}

export async function deleteGroup(id: number) {
  const userId = await requireUserId()
  await db.delete(igGroupAccounts).where(eq(igGroupAccounts.groupId, id))
  await db.delete(igGroups).where(and(eq(igGroups.id, id), eq(igGroups.userId, userId)))
  revalidatePath("/groups")
}

export async function setGroupMembers(groupId: number, accountIds: number[]) {
  // Ownership check: getGroup returns null when the group isn't the user's.
  if (!(await getGroup(groupId))) throw new Error("Group not found")
  await db.delete(igGroupAccounts).where(eq(igGroupAccounts.groupId, groupId))
  if (accountIds.length) {
    await db.insert(igGroupAccounts).values(accountIds.map((accountId) => ({ groupId, accountId })))
  }
  revalidatePath(`/groups/${groupId}`)
  revalidatePath("/groups")
}

export async function saveWorkflow(groupId: number, workflow: WorkflowStep[]) {
  const userId = await requireUserId()
  await db.update(igGroups).set({ workflow }).where(and(eq(igGroups.id, groupId), eq(igGroups.userId, userId)))
  revalidatePath(`/groups/${groupId}`)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// Execute the group's workflow for every member account, in order.
export async function runGroupWorkflow(groupId: number) {
  const group = await getGroup(groupId)
  if (!group) return { ok: false, error: "Group not found" }
  const workflow = (group.workflow as WorkflowStep[]) ?? []
  if (!workflow.length) return { ok: false, error: "Workflow is empty" }

  const results: { account: string; action: string; ok: boolean; status: number }[] = []

  for (const account of group.accounts) {
    const client = new InstagramClient(account)
    await client.rotateProxy()
    // Steps run in their defined order (which mirrors the request numbering).
    for (const step of workflow) {
      const action = getAction(step.action)
      if (!action) continue
      try {
        const res = await action.run(client, step.params ?? {}, account)
        await db.insert(igRunLogs).values({
          userId: group.userId,
          accountId: account.id,
          groupId,
          action: step.action,
          status: res.ok ? "ok" : "error",
          requestUrl: res.url,
          responseCode: res.status,
          message: res.ok ? "Success" : `HTTP ${res.status}`,
        })
        results.push({ account: account.label, action: step.action, ok: res.ok, status: res.status })
      } catch (e) {
        const message = e instanceof Error ? e.message : "failed"
        await db.insert(igRunLogs).values({
          userId: group.userId,
          accountId: account.id,
          groupId,
          action: step.action,
          status: "error",
          message: message.slice(0, 500),
        })
        results.push({ account: account.label, action: step.action, ok: false, status: 0 })
      }
      if (step.delayMs && step.delayMs > 0) await sleep(Math.min(step.delayMs, 30000))
    }
  }

  revalidatePath(`/groups/${groupId}`)
  return { ok: true, results }
}
