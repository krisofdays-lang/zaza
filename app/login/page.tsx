import type { Metadata } from "next"
import { Orbit } from "lucide-react"
import { LoginForm } from "@/components/login-form"

export const metadata: Metadata = {
  title: "Sign in · Orbit",
  description: "Enter your license key to continue.",
}

export default function LoginPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col items-center">
        {/* Brand */}
        <div className="flex size-16 items-center justify-center rounded-2xl ig-gradient-animated text-white shadow-lg">
          <Orbit className="size-8" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">Orbit Dashboard</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Enter your license key to continue</p>

        {/* Card */}
        <div className="mt-8 w-full rounded-2xl border border-border bg-card p-6 shadow-sm">
          <LoginForm />
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Access is granted by license key. Contact the owner if you don&apos;t have one.
        </p>
      </div>
    </main>
  )
}
