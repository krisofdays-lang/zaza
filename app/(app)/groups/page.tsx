import { getGroups } from "@/app/actions/groups"
import { getAccountsForDisplay } from "@/app/actions/accounts"
import { PageHeader } from "@/components/page-header"
import { GroupsList } from "@/components/groups/groups-list"

export const dynamic = "force-dynamic"

export default async function GroupsPage() {
  const [groups, accounts] = await Promise.all([getGroups(), getAccountsForDisplay()])
  return (
    <div className="flex flex-col">
      <PageHeader title="Groups" description="Organize accounts into groups." />
      <div className="px-6 py-5">
        <GroupsList
          groups={groups}
          accounts={accounts.map((a) => ({ id: a.id, label: a.label || a.username || `Account ${a.id}`, username: a.username, status: a.status || "idle" }))}
        />
      </div>
    </div>
  )
}
