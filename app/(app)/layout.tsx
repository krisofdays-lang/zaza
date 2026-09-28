import type React from "react"
import { redirect } from "next/navigation"
import { AppSidebar, MobileTopNav } from "@/components/app-sidebar"
import { PageTransition } from "@/components/page-transition"
import { getSessionUserId, getCurrentUserResult } from "@/lib/auth/session"

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Redirect gate uses the cookie-only check: it verifies the signed token
  // without a DB read, so a transient DB error can never turn into a redirect
  // loop or a crash here. The edge middleware only does a cheap presence check.
  const userId = await getSessionUserId()
  if (!userId) redirect("/login")

  // Display data for the sidebar. This never throws: on a transient DB error
  // `dbError` is true and we render the shell with safe defaults rather than
  // crashing the layout (a layout throw escapes the segment error boundary and
  // shows the red "Server Components render" overlay). Only redirect when the
  // session is genuinely gone (valid token but no user row, and no DB error).
  const { user, dbError } = await getCurrentUserResult()
  if (!user && !dbError) redirect("/login")

  const isAdmin = user?.isAdmin ?? false
  const licenseKey = user?.licenseKey

  return (
    <div className="flex min-h-svh">
      <AppSidebar isAdmin={isAdmin} licenseKey={licenseKey} />
      <div className="flex-1 flex flex-col min-w-0">
        <MobileTopNav isAdmin={isAdmin} />
        <main className="flex-1 min-w-0">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </div>
  )
}
