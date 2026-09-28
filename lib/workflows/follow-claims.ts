import { db } from "@/lib/db"
import { igFollowClaims } from "@/lib/db/schema"
import { and, eq, sql } from "drizzle-orm"

// ---------------------------------------------------------------------------
// Follow Targets claim primitive
//
// Goal: within a single Follow Targets run, accounts must DIVIDE the username
// list — if one account takes a username, every other account skips it. Because
// accounts run concurrently (in proxy lanes, and later across multiple workers),
// this cannot be coordinated in memory. We coordinate in Postgres instead:
//
//   1. seedFollowClaims() inserts every target username as a "pending" row,
//      scoped to the run via jobId.
//   2. Each account calls claimFollowTargets() to atomically grab its next
//      batch. The claim uses `FOR UPDATE SKIP LOCKED`, so two accounts racing
//      for the same rows can never grab the same one — the loser simply skips
//      locked rows and takes the next available ones.
//   3. After attempting a follow, the account marks the row done/failed.
//   4. clearFollowClaims() wipes the run's rows when it finishes (per-run dedup;
//      a future run starts with a clean, fully-open list).
// ---------------------------------------------------------------------------

// Seed the run's username list. Safe to call once at the start of a run; the
// unique (job_id, username) constraint means duplicate seeds are ignored.
export async function seedFollowClaims(jobId: number, usernames: string[]) {
  if (usernames.length === 0) return 0
  const rows = usernames.map((username) => ({ jobId, username }))
  const inserted = await db.insert(igFollowClaims).values(rows).onConflictDoNothing().returning({ id: igFollowClaims.id })
  return inserted.length
}

// Atomically claim up to `limit` still-pending usernames for one account.
// Returns the usernames this account now owns (and nobody else will touch).
export async function claimFollowTargets(jobId: number, accountId: number, limit: number): Promise<string[]> {
  if (limit <= 0) return []
  const result = await db.execute(sql`
    UPDATE ig_follow_claims
    SET status = 'claimed', account_id = ${accountId}, claimed_at = now()
    WHERE id IN (
      SELECT id FROM ig_follow_claims
      WHERE job_id = ${jobId} AND status = 'pending'
      ORDER BY id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING username
  `)
  // node-postgres returns { rows }; normalize defensively.
  const rows = (result as unknown as { rows?: { username: string }[] }).rows ?? (result as unknown as { username: string }[])
  return Array.isArray(rows) ? rows.map((r) => r.username) : []
}

// Record the outcome of a follow attempt for a claimed username.
export async function markFollowClaim(jobId: number, username: string, status: "done" | "failed") {
  await db
    .update(igFollowClaims)
    .set({ status })
    .where(and(eq(igFollowClaims.jobId, jobId), eq(igFollowClaims.username, username)))
}

// Remove all rows for a run. Called when the Follow Targets run completes so the
// list is fully open again next time (per-run dedup).
export async function clearFollowClaims(jobId: number) {
  await db.delete(igFollowClaims).where(eq(igFollowClaims.jobId, jobId))
}
