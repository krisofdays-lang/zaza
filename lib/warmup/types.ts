export type WarmupKind = "feed_scroll" | "reels_scroll" | "feed_training" | "stories_tracker"

// Per-action probabilities (0-100) plus the session length in minutes.
export interface WarmupConfig {
  like: number
  repost: number
  save: number
  follow: number
  durationMin: number
}

export const DEFAULT_WARMUP_CONFIG: WarmupConfig = {
  like: 30,
  repost: 5,
  save: 10,
  follow: 5,
  durationMin: 10,
}

export const DURATION_PRESETS = [5, 10, 15] as const

export interface WarmupJobStatus {
  id: number
  kind: WarmupKind
  status: "queued" | "running" | "done" | "error" | "cancelled"
  total: number
  processed: number
  actionsCount: number
  currentLabel: string
  phase: string
  error: string
  config: WarmupConfig
  accountIds: number[]
  groupId: number | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}
