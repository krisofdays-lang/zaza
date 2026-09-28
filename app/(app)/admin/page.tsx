import { redirect } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { getCurrentUser } from "@/lib/auth/session"
import { listLicenses } from "@/app/actions/admin"
import { AdminLicenses } from "@/components/admin/admin-licenses"

export const dynamic = "force-dynamic"

export default async function AdminPage() {
  // Owner-only. Non-admins are bounced to the dashboard.
  const user = await getCurrentUser()
  if (!user) redirect("/login")
  if (!user.isAdmin) redirect("/dashboard")

  const licenses = await listLicenses()

  return (
    <div className="flex flex-col">
      <PageHeader title="Admin" description="Issue and revoke license keys. Each key is an isolated workspace." />
      <AdminLicenses initial={licenses} currentUserId={user.id} />
    </div>
  )
}
