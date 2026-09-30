import { redirect } from "next/navigation"
import { getCurrentUser } from "@/lib/auth/session"

// Any unknown URL bounces the visitor to a real page: the dashboard when they
// have a valid session, otherwise the login screen.
export default async function NotFound() {
  let authed = false
  try {
    authed = Boolean(await getCurrentUser())
  } catch {
    authed = false
  }
  redirect(authed ? "/dashboard" : "/login")
}
