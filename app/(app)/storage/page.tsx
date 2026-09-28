import { PageHeader } from "@/components/page-header"
import { StorageManager } from "@/components/storage/storage-manager"
import { getMediaPaged } from "@/app/actions/storage"
import { getAccountsForDisplay } from "@/app/actions/accounts"

export const dynamic = "force-dynamic"

export default async function StoragePage() {
  const [{ items: media, total }, accounts] = await Promise.all([
    getMediaPaged(),
    getAccountsForDisplay(),
  ])
  // id -> display name map so the library can show which account a file is used by.
  const accountNames: Record<number, string> = {}
  for (const a of accounts) accountNames[a.id] = a.username || a.label || `Account ${a.id}`
  // Lightweight list powering the searchable account filter.
  const accountOptions = accounts.map((a) => ({
    id: a.id,
    name: a.username || a.label || `Account ${a.id}`,
  }))

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Storage"
        description="Upload content, generate uniqueized copies and manage your media library."
      />
      <div className="px-6 pb-10 pt-2">
        <StorageManager initialMedia={media} totalMedia={total} accountNames={accountNames} accounts={accountOptions} />
      </div>
    </div>
  )
}
