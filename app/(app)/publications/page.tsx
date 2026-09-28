import { PageHeader } from "@/components/page-header"
import { PublicationComposer } from "@/components/publications/publication-composer"
import { getAccountsForDisplay } from "@/app/actions/accounts"
import { getGroups } from "@/app/actions/groups"
import { getMediaForPicker } from "@/app/actions/storage"

export default async function PublicationsPage() {
  const [accounts, groups, media] = await Promise.all([getAccountsForDisplay(), getGroups(), getMediaForPicker()])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Publications"
        description="Compose Reels, Posts, Stories and Highlights, then publish to accounts or a whole group."
      />
      <PublicationComposer
        accounts={accounts}
        groups={groups.map((g) => ({ id: g.id, name: g.name, accountIds: g.accountIds }))}
        media={media}
      />
    </div>
  )
}
