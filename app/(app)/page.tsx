import { redirect } from "next/navigation"

// The Accounts section has been merged into the Dashboard. Keep the root path
// working by redirecting to it.
export default function RootPage() {
  redirect("/dashboard")
}
