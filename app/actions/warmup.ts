"use server"

import { db } from "@/lib/db"
import { igWarmupJobs } from "@/lib/db/schema"
import { and, count, desc, eq, inArray } from "drizzle-orm"
import { getAccounts } from "./accounts"
import { requireUserId } from "@/lib/auth/session"
import { runWarmupJob, WARMUP_JOB_STALE_MS } from "@/lib/warmup/runner"
import { DEFAULT_WARMUP_CONFIG, type WarmupConfig, type WarmupJobStatus, type WarmupKind } from "@/lib/warmup/types"

// Cap on how many warm-up jobs a single user can have running/queued at once.
const MAX_ACTIVE_JOBS_PER_USER = 50

// Count this user's jobs that are occupying a slot (running or queued).
async function countActiveJobs(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(igWarmupJobs)
    .where(and(eq(igWarmupJobs.userId, userId), inArray(igWarmupJobs.status, ["running", "queued"])))
  return row?.n ?? 0
}

function toStatus(row: typeof igWarmupJobs.$inferSelect): WarmupJobStatus {
  return {
    id: row.id,
    kind: row.kind as WarmupKind,
    status: row.status as WarmupJobStatus["status"],
    total: row.total,
    processed: row.processed,
    actionsCount: row.actionsCount,
    currentLabel: row.currentLabel,
    phase: row.phase,
    error: row.error,
    config: row.config as WarmupConfig,
    accountIds: (row.accountIds as number[]) ?? [],
    groupId: row.groupId,
    startedAt: row.startedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  }
}

// Start a warm-up session. Adds a job to the queue and kicks off the detached
// runner. Returns the new job id.
export async function startWarmup(input: {
  kind?: WarmupKind
  accountIds: number[]
  groupId?: number | null
  config: Partial<WarmupConfig>
  concurrency?: number
}): Promise<{ ok: boolean; jobId?: number; error?: string }> {
  const userId = await requireUserId()
  const all = await getAccounts()
  const ids = input.accountIds.filter((id) => all.some((a) => a.id === id))
  if (ids.length === 0) return { ok: false, error: "Select at least one account" }

  // Enforce the per-user concurrent job cap.
  const active = await countActiveJobs(userId)
  if (active >= MAX_ACTIVE_JOBS_PER_USER) {
    return { ok: false, error: `Достигнут лимит в ${MAX_ACTIVE_JOBS_PER_USER} одновременных задач. Дождитесь завершения или отмените часть.` }
  }

  const config: WarmupConfig = { ...DEFAULT_WARMUP_CONFIG, ...input.config }
  if (!config.durationMin || config.durationMin < 1) config.durationMin = 1

  const [job] = await db
    .insert(igWarmupJobs)
    .values({
      userId,
      kind: input.kind ?? "feed_scroll",
      status: "running",
      groupId: input.groupId ?? null,
      accountIds: ids,
      config,
      concurrency: input.concurrency != null ? Math.min(Math.max(input.concurrency, 1), 20) : null,
      total: ids.length,
      phase: "queued",
    })
    .returning()

  // Fire-and-forget: the runner paces itself over the configured minutes.
  void runWarmupJob(job.id)

  return { ok: true, jobId: job.id }
}

// The warm-up queue: recent jobs with live progress. Stale "running" jobs left
// behind by a dead process are flipped to errored so the UI stays honest.
export async function getWarmupJobs(limit = 20): Promise<WarmupJobStatus[]> {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(igWarmupJobs)
    .where(eq(igWarmupJobs.userId, userId))
    .orderBy(desc(igWarmupJobs.id))
    .limit(limit)
  const now = Date.now()
  const fixups: Promise<unknown>[] = []
  for (const row of rows) {
    if (row.status === "running" && now - row.updatedAt.getTime() > WARMUP_JOB_STALE_MS) {
      row.status = "error"
      row.error = "Stopped unexpectedly"
      fixups.push(
        db
          .update(igWarmupJobs)
          .set({ status: "error", error: "Stopped unexpectedly", finishedAt: new Date() })
          .where(eq(igWarmupJobs.id, row.id)),
      )
    }
  }
  if (fixups.length) await Promise.all(fixups)
  return rows.map(toStatus)
}

// Request cancellation. The runner notices the flag between actions and stops.
export async function cancelWarmup(jobId: number): Promise<{ ok: boolean }> {
  const userId = await requireUserId()
  await db
    .update(igWarmupJobs)
    .set({ cancelRequested: true, phase: "cancelling" })
    .where(and(eq(igWarmupJobs.id, jobId), eq(igWarmupJobs.userId, userId)))
  return { ok: true }
}

// Remove a single finished/errored/cancelled job from the queue list. Active
// jobs (running/queued) must be cancelled first and cannot be dismissed.
export async function dismissWarmupJob(jobId: number): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId()
  const [row] = await db
    .select()
    .from(igWarmupJobs)
    .where(and(eq(igWarmupJobs.id, jobId), eq(igWarmupJobs.userId, userId)))
  if (!row) return { ok: true }
  if (row.status === "running" || row.status === "queued") {
    return { ok: false, error: "Cancel the session before removing it." }
  }
  await db.delete(igWarmupJobs).where(and(eq(igWarmupJobs.id, jobId), eq(igWarmupJobs.userId, userId)))
  return { ok: true }
}

// Clear all finished jobs (done/error/cancelled) from the queue at once,
// leaving any running/queued sessions untouched.
export async function clearWarmupJobs(): Promise<{ ok: boolean; cleared: number }> {
  const userId = await requireUserId()
  const rows = await db
    .delete(igWarmupJobs)
    .where(and(eq(igWarmupJobs.userId, userId), inArray(igWarmupJobs.status, ["done", "error", "cancelled"])))
    .returning({ id: igWarmupJobs.id })
  return { ok: true, cleared: rows.length }
}
