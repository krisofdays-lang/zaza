import { redirect } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { getCurrentUser } from "@/lib/auth/session"
import { AutoregView } from "@/components/autoreg/autoreg-view"
import {
  listAutoregAccounts,
  getLatestAutoregJob,
  listAutoregLogs,
  listPlatformUsers,
  loadAutoregSettings,
} from "@/app/actions/autoreg"

export const dynamic = "force-dynamic"

export default async function AutoregPage() {
  const user = await getCurrentUser()
  if (!user) redirect("/login")
  if (!user.isAdmin) redirect("/dashboard")

  const [accounts, latestJob, platformUsers, savedSettings] = await Promise.all([
    listAutoregAccounts(),
    getLatestAutoregJob(),
    listPlatformUsers(),
    loadAutoregSettings(),
  ])

  // Load logs for the latest job (if any)
  const logs = latestJob ? await listAutoregLogs(latestJob.jobId) : []

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Auto Reg"
        description="Automatic Instagram account registration via email or SMS."
      />
      <AutoregView
        initialAccounts={accounts}
        initialJob={latestJob}
        initialLogs={logs}
        platformUsers={platformUsers}
        savedSettings={savedSettings}
      />
    </div>
  )
}
