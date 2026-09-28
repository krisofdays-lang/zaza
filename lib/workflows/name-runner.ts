import { getAccountById } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import type { NameChangeConfig } from "@/lib/workflows/types"

export interface NameOutcome {
  accountId: number
  status: "done" | "skipped" | "failed"
  reason?: string
}

// Execute the Name Change step for ONE account.
//
// Mirrors the captured request: POST /accounts/update_profile_name/ with the
// new first_name. If the response status is not "ok", the account is skipped
// (treated as not applied). Accounts with no name configured are skipped.
export async function runNameChangeForAccount(opts: {
  accountId: number
  config: NameChangeConfig
}): Promise<NameOutcome> {
  const { accountId, config } = opts
  const newName = (config.names[accountId] ?? "").trim()

  if (newName.length === 0) return { accountId, status: "skipped", reason: "no_name" }

  const account = await getAccountById(accountId)
  if (!account) return { accountId, status: "failed", reason: "account_not_found" }

  const c = new InstagramClient(account)
  try {
    const res = await ep.updateProfileName(c, newName)
    // Skip the account unless Instagram confirms status: "ok".
    if (res.ok && res.data?.status === "ok") return { accountId, status: "done" }
    return { accountId, status: "skipped", reason: `status_${res.data?.status ?? res.status}` }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "update_failed" }
  }
}
