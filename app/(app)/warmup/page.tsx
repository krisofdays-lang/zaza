import { PageHeader } from "@/components/page-header"
import { WarmupView } from "@/components/warmup/warmup-view"
import { getAccountsForDisplay } from "@/app/actions/accounts"
import { getGroups } from "@/app/actions/groups"
import { getWarmupJobs } from "@/app/actions/warmup"

export const dynamic = "force-dynamic"

export default async function WarmupPage() {
  const [accounts, groups, jobs] = await Promise.all([getAccountsForDisplay(), getGroups(), getWarmupJobs(20)])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Warm up"
        description="Imitate real activity to warm up accounts — scroll the feed and interact at human-like rates."
      />
      <WarmupView
        accounts={accounts}
        groups={groups.map((g) => ({ id: g.id, name: g.name, accountIds: g.accountIds }))}
        initialJobs={jobs}
      />
    </div>
  )
}
