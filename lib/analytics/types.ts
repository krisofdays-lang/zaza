// Shared analytics types. Kept in a plain module (no "use server") so both the
// background runner and client components can import them freely.

// One reel enriched with the account it belongs to, for ranking and display.
export interface AnalyticsReel {
  id: string
  code?: string
  accountId: number
  username: string
  label: string
  thumbnail?: string
  videoUrl?: string
  caption?: string
  views: number
  likes: number
  comments: number
}

// Aggregated metrics for a single account across its reels.
export interface AccountAnalytics {
  id: number
  username: string
  label: string
  avatar: string
  views: number
  likes: number
  comments: number
  reels: number
  // (likes + comments) / views, as a percentage.
  engagementRate: number
}

export interface AnalyticsResult {
  totals: {
    views: number
    likes: number
    comments: number
    reels: number
    accounts: number
    engagementRate: number
  }
  accounts: AccountAnalytics[]
  topReels: AnalyticsReel[]
  generatedAt: string
  // Accounts whose reels could not be fetched (proxy/auth failure etc.).
  failed: { id: number; username: string; label: string }[]
}

// Live status of a background refresh job, surfaced to the UI for polling.
export interface AnalyticsJobStatus {
  id: number
  status: "running" | "done" | "error"
  total: number
  processed: number
  currentLabel: string
  phase: string
  error: string
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}
