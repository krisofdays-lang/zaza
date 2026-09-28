import { PageHeader } from "@/components/page-header"
import { AccountFormDialog } from "@/components/accounts/account-form-dialog"
import { AccountsTable } from "@/components/accounts/accounts-table"
import { StatCard } from "@/components/dashboard/stat-card"
import { LiveJobs } from "@/components/dashboard/live-jobs"
import { getAccountsForDisplay, getDashboardActivity } from "@/app/actions/accounts"
import { getGroups } from "@/app/actions/groups"
import { Users, CircleCheck, TriangleAlert, ShieldCheck } from "lucide-react"

export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  // Each fetch degrades to an empty fallback instead of throwing. Every Server
  // Action re-renders this page; a transient DB error during that re-render
  // must not crash the render (which would trip the segment error boundary and
  // tear down any open dialog + its logs). A blip just yields empty data that
  // self-corrects on the next render.
  const [accounts, groups, activity] = await Promise.all([
    getAccountsForDisplay().catch(() => []),
    getGroups().catch(() => []),
    getDashboardActivity().catch(() => ({ activeJobs: [], recentJobs: [] })),
  ])

  // Stats
  const total = accounts.length
  const active = accounts.filter((a) => a.status === "ok" || a.status === "running").length
  const flagged = accounts.filter((a) => a.status === "error").length
  const proxied = accounts.filter((a) => a.proxyType && a.proxyType !== "none").length

  const groupNamesById = new Map<number, string[]>()
  for (const g of groups) {
    for (const accId of g.accountIds) {
      const list = groupNamesById.get(accId) ?? []
      list.push(g.name)
      groupNamesById.set(accId, list)
    }
  }

  // Group membership per account, for filtering / sorting / display in the table.
  const groupNamesByAccount: Record<number, string[]> = {}
  for (const [accId, names] of groupNamesById) groupNamesByAccount[accId] = names

  return (
    <div className="flex flex-col">
      <PageHeader title="Dashboard" description="Manage your Instagram accounts.">
        <div className="flex items-center gap-2">
          <AccountFormDialog mode="create" groups={groups.map((g) => ({ id: g.id, name: g.name }))} />
        </div>
      </PageHeader>

      <div className="space-y-6 px-6 py-5">
        {/* Stats */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total Accounts" value={total} icon={Users} chipClass="ig-gradient" />
          <StatCard label="Active Accounts" value={active} icon={CircleCheck} chipClass="bg-[#d62976]" />
          <StatCard
            label="Flagged Accounts"
            value={flagged}
            icon={TriangleAlert}
            chipClass="bg-[#fa7e1e]"
            dim={flagged === 0}
          />
          <StatCard label="Proxy Assigned" value={proxied} icon={ShieldCheck} chipClass="bg-[#4f5bd5]" />
        </div>

        {/* Jobs — live updating without a page refresh */}
        <LiveJobs initial={activity} />

        {/* Searchable accounts — full management (open phone, edit, refresh, groups) */}
        <AccountsTable
          accounts={accounts}
          groups={groups.map((g) => ({ id: g.id, name: g.name }))}
          groupNamesByAccount={groupNamesByAccount}
        />
      </div>
    </div>
  )
}
