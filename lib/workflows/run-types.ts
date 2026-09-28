// Serializable shapes returned by the workflow server actions to the client.
// Kept separate from the runner (which imports the DB) so client components can
// import these types without pulling server-only code into the bundle.

export type WorkflowRunStatus = "draft" | "running" | "done" | "error" | "cancelled"

export interface WorkflowSummary {
  id: number
  name: string
  status: WorkflowRunStatus
  total: number
  processed: number
  actionsCount: number
  accountCount: number
  // Aggregate completion 0..1 derived from per-node progress.
  percent: number
  currentLabel: string
  phase: string
  updatedAt: string
}

export interface WorkflowDetail extends WorkflowSummary {
  graph: { nodes: unknown[]; edges: unknown[] }
  accountIds: number[]
  progress: Record<string, { done: number; total: number }>
  currentNodeId: string
  error: string
  startedAt: string | null
  finishedAt: string | null
}

export interface WorkflowLogEntry {
  id: number
  accountId: number | null
  action: string
  status: string // "ok" | "error" | "pending"
  message: string
  responseCode: number | null
  createdAt: string
}
