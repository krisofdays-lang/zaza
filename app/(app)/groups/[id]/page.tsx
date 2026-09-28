import { notFound } from "next/navigation"
import Link from "next/link"
import { getGroup } from "@/app/actions/groups"
import { getAccountsForDisplay } from "@/app/actions/accounts"
import { MemberSelector } from "@/components/groups/member-selector"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"

export const dynamic = "force-dynamic"

export default async function GroupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const groupId = Number(id)
  const [group, accounts] = await Promise.all([getGroup(groupId), getAccountsForDisplay()])
  if (!group) notFound()

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Button render={<Link href="/groups" />} nativeButton={false} variant="ghost" size="sm">
        <ArrowLeft className="size-4" /> Groups
      </Button>

      <div>
        <h1 className="text-2xl font-semibold text-balance">{group.name}</h1>
        {group.description && <p className="mt-1 text-muted-foreground">{group.description}</p>}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold">Accounts in this group</h2>
        <MemberSelector
          groupId={groupId}
          accounts={accounts.map((a) => ({ id: a.id, label: a.label || a.username || `Account ${a.id}`, username: a.username }))}
          initialSelected={group.accountIds}
        />
      </div>
    </div>
  )
}
