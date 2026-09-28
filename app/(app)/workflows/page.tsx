import { getGroups } from "@/app/actions/groups"
import { getAccountsForDisplay } from "@/app/actions/accounts"
import { listWorkflows } from "@/app/actions/workflows"
import { WorkflowsView } from "@/components/workflows/workflows-view"

export const dynamic = "force-dynamic"

export default async function WorkflowsPage() {
  const [groups, accounts, workflows] = await Promise.all([getGroups(), getAccountsForDisplay(), listWorkflows()])
  return (
    <WorkflowsView
      initialWorkflows={workflows}
      accounts={accounts.map((a) => ({
        id: a.id,
        label: a.label || a.username || `Account ${a.id}`,
        username: a.username || "",
        status: a.status || "idle",
      }))}
      groups={groups.map((g) => ({
        id: g.id,
        name: g.name,
        accountIds: g.accountIds,
        accountCount: g.accountIds.length,
      }))}
    />
  )
}
