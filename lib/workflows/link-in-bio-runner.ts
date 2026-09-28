import { getAccountById } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import type { LinkInBioConfig } from "@/lib/workflows/types"

export interface LinkInBioOutcome {
  accountId: number
  status: "done" | "skipped" | "failed"
  reason?: string
}

// Execute the Link in Bio step for ONE account.
//
// Mirrors the captured flow:
// 1) IGNMEBenefitContextualPromoConfigsQuery — the passive promo-config query
//    the app fires when opening the links editor (informational, errors ignored),
// 2) POST /accounts/update_bio_links/ with the new external link.
// Accounts with no URL configured are skipped without firing any request.
export async function runLinkInBioForAccount(opts: {
  accountId: number
  config: LinkInBioConfig
}): Promise<LinkInBioOutcome> {
  const { accountId, config } = opts
  const url = (config.links[accountId] ?? "").trim()

  if (url.length === 0) return { accountId, status: "skipped", reason: "no_link" }

  const account = await getAccountById(accountId)
  if (!account) return { accountId, status: "failed", reason: "account_not_found" }

  const c = new InstagramClient(account)
  try {
    // Step 1: passive promo-config pre-check (mirrors opening the links editor).
    await ep.bioLinksPromoConfigs(c).catch(() => {})
    // Step 2: set the external bio link.
    const res = await ep.updateBioLinks(c, [{ url }])
    if (res.ok) return { accountId, status: "done" }
    return { accountId, status: "failed", reason: `http_${res.status}` }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "update_failed" }
  }
}
