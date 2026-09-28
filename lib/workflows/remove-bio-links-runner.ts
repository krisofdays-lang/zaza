import { getAccountById } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"

export interface RemoveBioLinksOutcome {
  accountId: number
  status: "done" | "skipped" | "failed"
  reason?: string
}

// Execute the Remove Bio Links step for ONE account. No per-account config —
// the step removes every external link on the account.
//
// Mirrors the captured flow:
// 1) IGNMEBenefitContextualPromoConfigsQuery — passive promo-config query fired
//    when opening the links editor (informational, errors ignored),
// 2) GET /accounts/current_user/?edit=true to read the existing bio_links,
// 3) POST /accounts/remove_bio_links/ with the collected link ids.
// Accounts with no links are skipped without firing the remove request.
export async function runRemoveBioLinksForAccount(opts: {
  accountId: number
}): Promise<RemoveBioLinksOutcome> {
  const { accountId } = opts

  const account = await getAccountById(accountId)
  if (!account) return { accountId, status: "failed", reason: "account_not_found" }

  const c = new InstagramClient(account)
  try {
    // Step 1: passive promo-config pre-check (mirrors opening the links editor).
    await ep.bioLinksPromoConfigs(c).catch(() => {})
    // Step 2: read current links to learn their ids.
    const current = await ep.getCurrentUser(c)
    const linkIds = (current.data?.user?.bio_links ?? [])
      .map((l) => l.link_id)
      .filter((id): id is string | number => id != null)

    if (linkIds.length === 0) return { accountId, status: "skipped", reason: "no_links" }

    // Step 3: remove every link.
    const res = await ep.removeBioLinks(c, linkIds)
    if (res.ok) return { accountId, status: "done" }
    return { accountId, status: "failed", reason: `http_${res.status}` }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "remove_failed" }
  }
}
