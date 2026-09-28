import { getAccountById } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import type { BioChangeConfig } from "@/lib/workflows/types"

export interface BioOutcome {
  accountId: number
  status: "done" | "unchanged" | "skipped" | "failed"
  reason?: string
}

// Execute the Biography Change step for ONE account.
//
// Mirrors the captured two-request flow:
//   1) GET /accounts/current_user/?edit=true — read the current biography,
//   2) POST /accounts/set_biography/ — write the new raw_text.
// Accounts with no bio configured (blank) are skipped, and if the current bio
// already matches the target we skip the write.
export async function runBioChangeForAccount(opts: {
  accountId: number
  config: BioChangeConfig
}): Promise<BioOutcome> {
  const { accountId, config } = opts
  const newBio = (config.bios[accountId] ?? "").trim()

  // No bio configured for this account — skip entirely.
  if (newBio.length === 0) return { accountId, status: "skipped", reason: "no_bio" }

  const account = await getAccountById(accountId)
  if (!account) return { accountId, status: "failed", reason: "account_not_found" }

  const c = new InstagramClient(account)

  // 1. Read the current biography first (matches real-app traffic).
  let current: string | undefined
  try {
    const res = await ep.getCurrentUser(c)
    if (res.ok && typeof res.data?.user?.biography === "string") current = res.data.user.biography
  } catch {
    // If the read fails we still attempt the write below.
  }

  // Already set to the desired bio — nothing to change.
  if (current === newBio) return { accountId, status: "unchanged" }

  // 2. Write the new biography.
  try {
    const res = await ep.setBiography(c, newBio)
    const ok = res.ok && res.data?.status !== "fail"
    return ok ? { accountId, status: "done" } : { accountId, status: "failed", reason: `http_${res.status}` }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "set_failed" }
  }
}
