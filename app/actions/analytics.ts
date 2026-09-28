"use server"

import { db } from "@/lib/db"
import { igAnalyticsJobs, igAnalyticsSnapshots } from "@/lib/db/schema"
import { and, desc, eq } from "drizzle-orm"
import { getAccounts } from "./accounts"
import { requireUserId } from "@/lib/auth/session"
import { runAnalyticsJob, SNAPSHOT_TTL_MS, JOB_STALE_MS } from "@/lib/analytics/runner"
import type { AnalyticsResult, AnalyticsJobStatus } from "@/lib/analytics/types"

export type { AnalyticsResult, AnalyticsReel, AccountAnalytics, AnalyticsJobStatus } from "@/lib/analytics/types"

// The newest cached snapshot, shown instantly on page open. `stale` is true when
// it is older than the TTL so the UI can hint that a refresh is recommended.
export async function getLatestSnapshot(): Promise<{
  result: AnalyticsResult | null
  generatedAt: string | null
  stale: boolean
}> {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(igAnalyticsSnapshots)
    .where(eq(igAnalyticsSnapshots.userId, userId))
    .orderBy(desc(igAnalyticsSnapshots.generatedAt))
    .limit(1)
  const row = rows[0]
  if (!row) return { result: null, generatedAt: null, stale: true }
  const generatedAt = row.generatedAt.toISOString()
  const stale = Date.now() - row.generatedAt.getTime() > SNAPSHOT_TTL_MS
  return { result: row.data as AnalyticsResult, generatedAt, stale }
}

function toStatus(row: typeof igAnalyticsJobs.$inferSelect): AnalyticsJobStatus {
  return {
    id: row.id,
    status: row.status as AnalyticsJobStatus["status"],
    total: row.total,
    processed: row.processed,
    currentLabel: row.currentLabel,
    phase: row.phase,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  }
}

// Start a background refresh. If a job is already running (and not stale) we
// return it instead of starting a duplicate. Stale "running" jobs left behind by
// a dead process are marked as errored so a fresh run can take over.
export async function startAnalyticsRefresh(
  accountIds?: number[],
): Promise<{ jobId: number; alreadyRunning: boolean }> {
  const userId = await requireUserId()
  const running = await db
    .select()
    .from(igAnalyticsJobs)
    .where(and(eq(igAnalyticsJobs.status, "running"), eq(igAnalyticsJobs.userId, userId)))
    .orderBy(desc(igAnalyticsJobs.updatedAt))
    .limit(1)

  const active = running[0]
  if (active) {
    const fresh = Date.now() - active.updatedAt.getTime() < JOB_STALE_MS
    if (fresh) return { jobId: active.id, alreadyRunning: true }
    await db
      .update(igAnalyticsJobs)
      .set({ status: "error", error: "Superseded (stale)", finishedAt: new Date() })
      .where(eq(igAnalyticsJobs.id, active.id))
  }

  const all = await getAccounts()
  const ids = accountIds && accountIds.length ? all.filter((a) => accountIds.includes(a.id)).map((a) => a.id) : []
  const [job] = await db
    .insert(igAnalyticsJobs)
    .values({ userId, status: "running", total: all.length, accountIds: ids, phase: "queued" })
    .returning()

  // Fire-and-forget: the runner paces itself over minutes and persists progress.
  void runAnalyticsJob(job.id, userId, ids)

  return { jobId: job.id, alreadyRunning: false }
}

// Poll a specific job (or the most recent one) for live progress.
export async function getAnalyticsJob(jobId?: number): Promise<AnalyticsJobStatus | null> {
  const userId = await requireUserId()
  const rows = jobId
    ? await db
        .select()
        .from(igAnalyticsJobs)
        .where(and(eq(igAnalyticsJobs.id, jobId), eq(igAnalyticsJobs.userId, userId)))
        .limit(1)
    : await db
        .select()
        .from(igAnalyticsJobs)
        .where(eq(igAnalyticsJobs.userId, userId))
        .orderBy(desc(igAnalyticsJobs.id))
        .limit(1)
  const row = rows[0]
  return row ? toStatus(row) : null
}
