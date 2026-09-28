import { PageHeader } from "@/components/page-header"
import { AnalyticsView } from "@/components/analytics/analytics-view"
import { getAccountsForDisplay } from "@/app/actions/accounts"
import { getLatestSnapshot, getAnalyticsJob } from "@/app/actions/analytics"
import type { AnalyticsResult } from "@/lib/analytics/types"

export const dynamic = "force-dynamic"

// Shown only when there is no cached snapshot yet.
const EMPTY: AnalyticsResult = {
  totals: { views: 0, likes: 0, comments: 0, reels: 0, accounts: 0, engagementRate: 0 },
  accounts: [],
  topReels: [],
  generatedAt: new Date(0).toISOString(),
  failed: [],
}

export default async function AnalyticsPage() {
  // Read the cached snapshot from the DB so the page renders instantly without
  // ever hitting the private API. Live data is only pulled on an explicit refresh.
  const [accounts, snapshot, latestJob] = await Promise.all([getAccountsForDisplay(), getLatestSnapshot(), getAnalyticsJob()])

  const initialJob = latestJob && latestJob.status === "running" ? latestJob : null

  return (
    <div className="flex flex-col">
      <PageHeader title="Analytics" description="Performance metrics across your account strategies." />
      <AnalyticsView
        initial={snapshot.result ?? EMPTY}
        hasSnapshot={!!snapshot.result}
        generatedAt={snapshot.generatedAt}
        stale={snapshot.stale}
        initialJob={initialJob}
        accounts={accounts.map((a) => ({ id: a.id, username: a.username, label: a.label }))}
      />
    </div>
  )
}
