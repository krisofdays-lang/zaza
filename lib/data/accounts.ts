import "server-only"
import { db } from "@/lib/db"
import { igAccounts } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"

// Cookie-free account loader for detached job runners (analytics/warmup/
// workflows). These run fire-and-forget after the response is sent, so they
// cannot rely on the request cookie / requireUser(). Instead the runner derives
// the owning userId from its own job row and loads that user's accounts here.
export async function getAccountsForUser(userId: number | null) {
  if (userId == null) return []
  return db.select().from(igAccounts).where(eq(igAccounts.userId, userId)).orderBy(desc(igAccounts.createdAt))
}

// Cookie-free single-account loader for detached per-account step runners.
// Ownership is enforced upstream: the workflow runner only ever loads/iterates
// the workflow owner's accounts, so ids handed to these runners are trusted.
export async function getAccountById(id: number) {
  const rows = await db.select().from(igAccounts).where(eq(igAccounts.id, id)).limit(1)
  return rows[0] ?? null
}
