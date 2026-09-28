import { getAccountById } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import type { UsernameChangeConfig } from "@/lib/workflows/types"

export interface UsernameOutcome {
  accountId: number
  status: "done" | "skipped" | "failed"
  reason?: string
}

// Execute the Username Change step for ONE account.
//
// Mirrors the captured two-step flow:
// 1) IGFXIMGenericIdentityReminderQuery — the passive identity reminder the app
//    fires before opening the username editor (informational, errors ignored),
// 2) POST /accounts/update_profile_username/ with the new username.
// If the response status is not "ok", the account is skipped (not applied).
// Accounts with no username configured are skipped without firing any request.
export async function runUsernameChangeForAccount(opts: {
  accountId: number
  config: UsernameChangeConfig
}): Promise<UsernameOutcome> {
  const { accountId, config } = opts
  const newUsername = (config.usernames[accountId] ?? "").trim()

  if (newUsername.length === 0) return { accountId, status: "skipped", reason: "no_username" }

  const account = await getAccountById(accountId)
  if (!account) return { accountId, status: "failed", reason: "account_not_found" }

  const c = new InstagramClient(account)
  try {
    // Step 1: passive identity reminder pre-check (mirrors app traffic).
    await ep.identityReminderUsername(c).catch(() => {})
    // Step 2: actually change the username.
    const res = await ep.updateProfileUsername(c, newUsername)
    if (res.ok && res.data?.status === "ok") return { accountId, status: "done" }
    return { accountId, status: "skipped", reason: `status_${res.data?.status ?? res.status}` }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "update_failed" }
  }
}
