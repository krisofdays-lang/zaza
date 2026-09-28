"use server"

import { redirect } from "next/navigation"
import { loginWithLicenseKey, logout as clearSession } from "@/lib/auth/session"

// Validate a license key from the login form. Returns an error string on
// failure; on success it sets the cookie and redirects to the dashboard.
export async function loginAction(_prev: { error?: string } | undefined, formData: FormData): Promise<{ error?: string }> {
  const licenseKey = String(formData.get("licenseKey") || "").trim()
  if (!licenseKey) return { error: "Enter your license key." }

  const user = await loginWithLicenseKey(licenseKey)
  if (!user) return { error: "Invalid license key." }

  redirect("/")
}

export async function logoutAction(): Promise<void> {
  await clearSession()
  redirect("/login")
}
