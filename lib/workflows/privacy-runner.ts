import { getAccountById } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import type { AccountPrivacyConfig } from "@/lib/workflows/types"

export interface PrivacyOutcome {
  accountId: number
  target: "private" | "public"
  status: "done" | "unchanged" | "failed"
  reason?: string
}

// Execute the Account Privacy step for ONE account.
//
// Mirrors the captured two-request flow:
//   1) IGSettingsBooleanQuery  (get_bool) — read the current account_privacy,
//   2) IGSettingsBooleanMutation (set_bool) — write the desired value.
// The per-account toggle decides the target: ON = private (value:true),
// OFF = public (value:false). If the account is already in the desired state we
// skip the mutation. Every listed account is processed (no skipping).
export async function runAccountPrivacyForAccount(opts: {
  accountId: number
  config: AccountPrivacyConfig
}): Promise<PrivacyOutcome> {
  const { accountId, config } = opts
  // The node may have been dropped onto the canvas without ever opening its
  // panel, so `config` can be `{}` with no `publicAccountIds`. Default to an
  // empty list (all accounts → private) instead of crashing on `.includes`.
  const publicAccountIds = config?.publicAccountIds ?? []
  const wantPrivate = !publicAccountIds.includes(accountId)
  const target = wantPrivate ? "private" : "public"

  const account = await getAccountById(accountId)
  if (!account) return { accountId, target, status: "failed", reason: "account_not_found" }

  const c = new InstagramClient(account)

  // 1. Read the current value first (matches real-app traffic).
  let current: boolean | undefined
  try {
    const res = await ep.getAccountPrivacy(c)
    const v = res.data?.data?.xdt_api__v1__settings__get_bool?.value
    if (res.ok && typeof v === "boolean") current = v
  } catch {
    // If the read fails we still attempt the mutation below.
  }

  // Already in the desired state — nothing to change.
  if (current === wantPrivate) return { accountId, target, status: "unchanged" }

  // 2. Apply the desired privacy value.
  try {
    const res = await ep.setAccountPrivacy(c, wantPrivate)
    const v = res.data?.data?.xdt_api__v1__settings__set_bool?.value
    const ok = res.ok && (typeof v !== "boolean" || v === wantPrivate)
    return ok
      ? { accountId, target, status: "done" }
      : { accountId, target, status: "failed", reason: `unexpected_value:${String(v)}` }
  } catch (err) {
    return { accountId, target, status: "failed", reason: err instanceof Error ? err.message : "set_failed" }
  }
}
