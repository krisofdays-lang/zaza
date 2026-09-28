"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { getWorkflow, getWorkflowLogs, runWorkflow, stopWorkflow } from "@/app/actions/workflows"
import type { WorkflowDetail, WorkflowLogEntry } from "@/lib/workflows/run-types"

// How often the editor polls the server for live run state while a workflow is
// running. Fast enough to feel live, light enough for the DB.
const POLL_MS = 3000

export type RunStatus = "idle" | "running" | "done" | "error" | "cancelled"

export interface RunLogEntry {
  id: string
  ts: number
  account: string
  action: string
  message: string
  level: "info" | "ok" | "error" | "wait" | "rotate"
  // When true this is a visual "── New run ──" separator, not a real log row.
  divider?: boolean
}

export interface RunState {
  status: RunStatus
  startedAt: number | null
  // nodeId -> aggregate progress across all accounts running that node.
  progress: Record<string, { done: number; total: number }>
  currentNodeId: string
  currentLabel: string
  phase: string
  error: string
  logs: RunLogEntry[]
}

const INITIAL: RunState = {
  status: "idle",
  startedAt: null,
  progress: {},
  currentNodeId: "",
  currentLabel: "",
  phase: "",
  error: "",
  logs: [],
}

// Map a server status onto the client run status. "draft" is treated as idle.
function mapStatus(s: WorkflowDetail["status"]): RunStatus {
  return s === "draft" ? "idle" : s
}

// Classify a server log row into a visual level for the Live Logs panel.
function levelOf(l: WorkflowLogEntry): RunLogEntry["level"] {
  if (l.status === "error") return "error"
  if (l.action === "Proxy") {
    return /пауз|cooldown|мин|wait/i.test(l.message) ? "wait" : "rotate"
  }
  if (l.status === "pending") return "info"
  return "ok"
}

function toLogEntry(l: WorkflowLogEntry, accountLabel: (id: number | null) => string): RunLogEntry {
  return {
    id: `l-${l.id}`,
    ts: new Date(l.createdAt).getTime(),
    account: accountLabel(l.accountId),
    action: l.action,
    message: l.message,
    level: levelOf(l),
  }
}

// Build the initial RunState from a workflow detail loaded on the server (so a
// re-entered, already-running workflow shows progress immediately).
function detailToState(detail: WorkflowDetail | null): RunState {
  if (!detail) return INITIAL
  return {
    status: mapStatus(detail.status),
    startedAt: detail.startedAt ? new Date(detail.startedAt).getTime() : null,
    progress: detail.progress ?? {},
    currentNodeId: detail.currentNodeId ?? "",
    currentLabel: detail.currentLabel ?? "",
    phase: detail.phase ?? "",
    error: detail.error ?? "",
    logs: [],
  }
}

export interface RunInput {
  name: string
  graph: { nodes: unknown[]; edges: unknown[] }
  accountIds: number[]
}

// Drives a single workflow's run lifecycle by polling the server. `accountLabel`
// resolves an account id to a display handle for the log lines.
export function useWorkflowRun(
  workflowId: number,
  initialDetail: WorkflowDetail | null,
  accountLabel: (id: number | null) => string,
) {
  const [state, setState] = useState<RunState>(() => detailToState(initialDetail))
  const sinceRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const labelRef = useRef(accountLabel)
  labelRef.current = accountLabel

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // One poll cycle: refresh run state + append any new log rows.
  const poll = useCallback(async () => {
    const [detail, logs] = await Promise.all([
      getWorkflow(workflowId),
      getWorkflowLogs(workflowId, sinceRef.current),
    ])
    if (!detail) return
    if (logs.length) sinceRef.current = logs[logs.length - 1].id

    setState((s) => ({
      status: mapStatus(detail.status),
      startedAt: detail.startedAt ? new Date(detail.startedAt).getTime() : s.startedAt,
      progress: detail.progress ?? {},
      currentNodeId: detail.currentNodeId ?? "",
      currentLabel: detail.currentLabel ?? "",
      phase: detail.phase ?? "",
      error: detail.error ?? "",
      logs: [...s.logs, ...logs.map((l) => toLogEntry(l, labelRef.current))].slice(-400),
    }))

    if (detail.status === "running") {
      timerRef.current = setTimeout(poll, POLL_MS)
    } else {
      clearTimer()
    }
  }, [workflowId, clearTimer])

  // Begin (or resume) polling when running.
  const beginPolling = useCallback(() => {
    clearTimer()
    void poll()
  }, [clearTimer, poll])

  const start = useCallback(
    async (input: RunInput) => {
      // Keep prior run logs; just append a divider so history is preserved and
      // scrollable across runs instead of being wiped on each start.
      sinceRef.current = 0
      const now = Date.now()
      setState((s) => {
        const prior = s.logs.length
          ? [
              ...s.logs,
              {
                id: `divider-${now}`,
                ts: now,
                account: "",
                action: "",
                message: "New run",
                level: "info" as const,
                divider: true,
              },
            ]
          : []
        return { ...INITIAL, status: "running", startedAt: now, logs: prior.slice(-400) }
      })
      const res = await runWorkflow(workflowId, input)
      if (!res.ok) {
        setState((s) => ({ ...s, status: "idle" }))
        return res
      }
      beginPolling()
      return res
    },
    [workflowId, beginPolling],
  )

  const stop = useCallback(async () => {
    await stopWorkflow(workflowId)
    void poll()
  }, [workflowId, poll])

  // If we entered on an already-running workflow, start polling immediately.
  useEffect(() => {
    if (initialDetail?.status === "running") beginPolling()
    return clearTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { state, start, stop }
}
