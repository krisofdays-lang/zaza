"use server"

import { db } from "@/lib/db"
import { igWorkflows, igRunLogs, igAccounts } from "@/lib/db/schema"
import { and, desc, eq, gt, gte, lt, inArray } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { requireUserId } from "@/lib/auth/session"
import { runWorkflowJob, WORKFLOW_JOB_STALE_MS } from "@/lib/workflows/runner"
import type {
  WorkflowSummary,
  WorkflowDetail,
  WorkflowRunStatus,
  WorkflowLogEntry,
} from "@/lib/workflows/run-types"

type Row = typeof igWorkflows.$inferSelect

// Aggregate completion across all nodes: total done / total expected.
function percentOf(row: Row): number {
  const progress = (row.progress as Record<string, { done: number; total: number }>) ?? {}
  let done = 0
  let total = 0
  for (const p of Object.values(progress)) {
    done += p.done
    total += p.total
  }
  if (total === 0) return row.status === "done" ? 1 : 0
  return Math.min(1, done / total)
}

function toSummary(row: Row): WorkflowSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status as WorkflowRunStatus,
    total: row.total,
    processed: row.processed,
    actionsCount: row.actionsCount,
    accountCount: ((row.accountIds as number[]) ?? []).length,
    percent: percentOf(row),
    currentLabel: row.currentLabel,
    phase: row.phase,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toDetail(row: Row): WorkflowDetail {
  return {
    ...toSummary(row),
    graph: (row.graph as WorkflowDetail["graph"]) ?? { nodes: [], edges: [] },
    accountIds: (row.accountIds as number[]) ?? [],
    progress: (row.progress as Record<string, { done: number; total: number }>) ?? {},
    currentNodeId: row.currentNodeId,
    error: row.error,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  }
}

// Flip "running" rows abandoned by a dead process to errored so the UI is honest.
// Uses a conditional UPDATE: only marks error if updatedAt is STILL stale at write
// time, so a heartbeat that just fired between our SELECT and this UPDATE wins.
async function reconcileStale(rows: Row[]): Promise<Row[]> {
  const now = Date.now()
  const staleThreshold = new Date(now - WORKFLOW_JOB_STALE_MS)
  const fixups: Promise<unknown>[] = []
  for (const row of rows) {
    if (row.status === "running" && row.updatedAt < staleThreshold) {
      fixups.push(
        db
          .update(igWorkflows)
          .set({ status: "error", error: "Stopped unexpectedly", finishedAt: new Date() })
          .where(
            and(
              eq(igWorkflows.id, row.id),
              eq(igWorkflows.status, "running"),
              lt(igWorkflows.updatedAt, staleThreshold),
            ),
          )
          .then(async () => {
            // Re-read to get the real status (heartbeat may have saved it)
            const [fresh] = await db
              .select({ status: igWorkflows.status, error: igWorkflows.error })
              .from(igWorkflows)
              .where(eq(igWorkflows.id, row.id))
              .limit(1)
            if (fresh) {
              row.status = fresh.status as typeof row.status
              row.error = fresh.error
            }
          }),
      )
    }
  }
  if (fixups.length) await Promise.all(fixups)
  return rows
}

// List workflows for the index page, with live status + progress.
export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const userId = await requireUserId()
  const rows = await reconcileStale(
    await db.select().from(igWorkflows).where(eq(igWorkflows.userId, userId)).orderBy(desc(igWorkflows.id)),
  )
  return rows.map(toSummary)
}

// Full workflow (graph + accounts + live run state) for the editor.
// NOTE: does NOT call reconcileStale — this is polled every 1.5s by the client,
// and reconcileStale is only needed on the list page to mark truly dead jobs.
export async function getWorkflow(id: number): Promise<WorkflowDetail | null> {
  const userId = await requireUserId()
  const [row] = await db
    .select()
    .from(igWorkflows)
    .where(and(eq(igWorkflows.id, id), eq(igWorkflows.userId, userId)))
    .limit(1)
  return row ? toDetail(row) : null
}

// Create an empty workflow and return its real numeric id.
export async function createWorkflow(name = "Untitled Workflow", accountIds: number[] = []): Promise<{ id: number }> {
  const userId = await requireUserId()
  const [row] = await db
    .insert(igWorkflows)
    .values({ userId, name, accountIds })
    .returning({ id: igWorkflows.id })
  revalidatePath("/workflows")
  return { id: row.id }
}

// Persist the editor graph + name + selected accounts. Does not touch run state.
export async function saveWorkflowGraph(
  id: number,
  input: { name: string; graph: { nodes: unknown[]; edges: unknown[] }; accountIds: number[] },
): Promise<{ ok: boolean }> {
  const userId = await requireUserId()
  await db
    .update(igWorkflows)
    .set({
      name: input.name,
      graph: input.graph,
      accountIds: input.accountIds,
      updatedAt: new Date(),
    })
    .where(and(eq(igWorkflows.id, id), eq(igWorkflows.userId, userId)))
  revalidatePath("/workflows")
  return { ok: true }
}

// Update ONLY the name + targeted accounts of a workflow, preserving the graph
// (chain, actions, uploaded content). When accounts are removed from targeting,
// their per-node references (reel/media assignments, per-account bios/names/etc.,
// public-account lists) are pruned so the removed account's data goes away while
// the chain and every other account stay intact.
export async function updateWorkflowTargeting(
  id: number,
  input: { name: string; accountIds: number[] },
): Promise<{ ok: boolean }> {
  const userId = await requireUserId()
  const [existing] = await db
    .select({ graph: igWorkflows.graph })
    .from(igWorkflows)
    .where(and(eq(igWorkflows.id, id), eq(igWorkflows.userId, userId)))
    .limit(1)
  const keep = new Set(input.accountIds)
  const graph = pruneGraphAccounts(existing?.graph, keep)
  await db
    .update(igWorkflows)
    .set({ name: input.name, accountIds: input.accountIds, graph, updatedAt: new Date() })
    .where(and(eq(igWorkflows.id, id), eq(igWorkflows.userId, userId)))
  revalidatePath("/workflows")
  return { ok: true }
}

// Strip references to accounts outside `keep` from every node's config, leaving
// nodes, edges, and other accounts' data untouched. Handles the three shapes the
// editor uses: assignment arrays keyed by `accountId`, `publicAccountIds` number
// lists, and records keyed by a numeric accountId (bios/names/usernames/links).
function pruneGraphAccounts(graph: unknown, keep: Set<number>): unknown {
  if (!graph || typeof graph !== "object") return graph
  const g = graph as { nodes?: unknown[]; edges?: unknown[] }
  if (!Array.isArray(g.nodes)) return graph
  const nodes = g.nodes.map((node) => {
    const n = node as { data?: { config?: Record<string, unknown> } }
    const cfg = n?.data?.config
    if (!cfg || typeof cfg !== "object") return node
    const next: Record<string, unknown> = { ...cfg }
    for (const [key, value] of Object.entries(cfg)) {
      if (Array.isArray(value)) {
        if (key === "publicAccountIds") {
          next[key] = (value as number[]).filter((aid) => keep.has(aid))
        } else if (value.length && value.every((it) => it && typeof it === "object" && "accountId" in (it as object))) {
          next[key] = (value as { accountId: number }[]).filter((it) => keep.has(it.accountId))
        }
      } else if (value && typeof value === "object") {
        const rec = value as Record<string, unknown>
        const keys = Object.keys(rec)
        if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
          const filtered: Record<string, unknown> = {}
          for (const k of keys) if (keep.has(Number(k))) filtered[k] = rec[k]
          next[key] = filtered
        }
      }
    }
    return { ...(node as object), data: { ...n.data, config: next } }
  })
  return { ...g, nodes }
}

// Auto-save the current graph, then launch the detached runner. Returns ok.
export async function runWorkflow(
  id: number,
  input: { name: string; graph: { nodes: unknown[]; edges: unknown[] }; accountIds: number[] },
): Promise<{ ok: boolean; error?: string }> {
  const userId = await requireUserId()
  // Lightweight check — only fetch IDs that actually exist for this user,
  // instead of pulling every column for every account (which produces a
  // multi-MB payload with 50+ accounts and freezes the browser).
  const validRows = input.accountIds.length > 0
    ? await db
        .select({ id: igAccounts.id })
        .from(igAccounts)
        .where(and(eq(igAccounts.userId, userId), inArray(igAccounts.id, input.accountIds)))
    : []
  const ids = validRows.map((r) => r.id)
  if (ids.length === 0) return { ok: false, error: "Select at least one account" }

  // Save first so a re-entry shows exactly what is running, then reset run state.
  await db
    .update(igWorkflows)
    .set({
      name: input.name,
      graph: input.graph,
      accountIds: ids,
      status: "running",
      cancelRequested: false,
      total: ids.length,
      processed: 0,
      actionsCount: 0,
      progress: {},
      currentNodeId: "",
      currentLabel: "",
      phase: "starting",
      error: "",
      startedAt: new Date(),
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(igWorkflows.id, id), eq(igWorkflows.userId, userId)))

  // Fire-and-forget: the runner paces itself and writes state back to the row.
  void runWorkflowJob(id)
  revalidatePath("/workflows")
  return { ok: true }
}

// Request a stop AND immediately reset the visible run values. The detached
// runner notices the cancel flag between nodes / during sleeps and exits
// shortly after; resetting here means the node badges (1/3, 0/3) and counters
// clear right away instead of freezing on their last values.
export async function stopWorkflow(id: number): Promise<{ ok: boolean }> {
  const userId = await requireUserId()
  await db
    .update(igWorkflows)
    .set({
      cancelRequested: true,
      status: "cancelled",
      processed: 0,
      actionsCount: 0,
      progress: {},
      currentNodeId: "",
      currentLabel: "",
      phase: "stopped",
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(igWorkflows.id, id), eq(igWorkflows.userId, userId)))
  revalidatePath("/workflows")
  return { ok: true }
}

export async function deleteWorkflow(id: number): Promise<{ ok: boolean }> {
  const userId = await requireUserId()
  await db.delete(igWorkflows).where(and(eq(igWorkflows.id, id), eq(igWorkflows.userId, userId)))
  revalidatePath("/workflows")
  return { ok: true }
}

// Recent activity for the Live Logs panel. Scoped to this run's accounts since
// it started, and incremental via `sinceId` so polling only fetches new rows.
export async function getWorkflowLogs(id: number, sinceId = 0): Promise<WorkflowLogEntry[]> {
  const userId = await requireUserId()
  const rows = await db
    .select()
    .from(igWorkflows)
    .where(and(eq(igWorkflows.id, id), eq(igWorkflows.userId, userId)))
    .limit(1)
  const wf = rows[0]
  if (!wf) return []
  const accountIds = (wf.accountIds as number[]) ?? []
  if (accountIds.length === 0) return []

  const since = wf.startedAt ?? new Date(0)
  const logs = await db
    .select()
    .from(igRunLogs)
    .where(
      and(
        inArray(igRunLogs.accountId, accountIds),
        gte(igRunLogs.createdAt, since),
        gt(igRunLogs.id, sinceId),
      ),
    )
    .orderBy(desc(igRunLogs.id))
    .limit(200)

  return logs.reverse().map((l) => ({
    id: l.id,
    accountId: l.accountId,
    action: l.action,
    status: l.status,
    message: l.message,
    responseCode: l.responseCode,
    createdAt: l.createdAt.toISOString(),
  }))
}
