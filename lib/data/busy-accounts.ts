import { db } from "@/lib/db"
import { igWorkflows, igWarmupJobs, igPublications } from "@/lib/db/schema"
import { and, eq, gt } from "drizzle-orm"

// An account is considered "in work" when it belongs to a currently-running
// workflow, warmup job, or publication. Analytics Refresh uses this to avoid
// hitting an account (rotating its proxy, pulling reels) while it is mid-way
// through another action — that would race the other task on the same session.
//
// Freshness guards protect against dead processes leaving a job stuck at
// "running": workflow/warmup jobs heartbeat `updatedAt`, so we only trust ones
// updated recently. Publications have no heartbeat (they run synchronously and
// only carry `createdAt`), so we treat recently-created ones as still active.
const JOB_HEARTBEAT_MS = 8 * 60 * 1000 // workflow / warmup: trust if updated within 8m
const PUBLICATION_ACTIVE_MS = 30 * 60 * 1000 // publication: assume active within 30m of creation

function collectIds(rows: { accountIds: unknown }[], into: Set<number>) {
  for (const row of rows) {
    const ids = row.accountIds
    if (Array.isArray(ids)) {
      for (const id of ids) if (typeof id === "number") into.add(id)
    }
  }
}

// Returns the set of account ids that are currently busy with another task for
// this user. Cheap indexed status lookups; safe to call repeatedly.
export async function getBusyAccountIds(userId: number): Promise<Set<number>> {
  const now = Date.now()
  const heartbeatCutoff = new Date(now - JOB_HEARTBEAT_MS)
  const publicationCutoff = new Date(now - PUBLICATION_ACTIVE_MS)

  const [workflows, warmups, publications] = await Promise.all([
    db
      .select({ accountIds: igWorkflows.accountIds })
      .from(igWorkflows)
      .where(and(eq(igWorkflows.userId, userId), eq(igWorkflows.status, "running"), gt(igWorkflows.updatedAt, heartbeatCutoff))),
    db
      .select({ accountIds: igWarmupJobs.accountIds })
      .from(igWarmupJobs)
      .where(and(eq(igWarmupJobs.userId, userId), eq(igWarmupJobs.status, "running"), gt(igWarmupJobs.updatedAt, heartbeatCutoff))),
    db
      .select({ accountIds: igPublications.accountIds })
      .from(igPublications)
      .where(and(eq(igPublications.userId, userId), eq(igPublications.status, "running"), gt(igPublications.createdAt, publicationCutoff))),
  ])

  const busy = new Set<number>()
  collectIds(workflows, busy)
  collectIds(warmups, busy)
  collectIds(publications, busy)
  return busy
}
