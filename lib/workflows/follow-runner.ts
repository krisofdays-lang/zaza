import { getAccountById } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import type { FollowTargetsConfig } from "@/lib/workflows/types"
import { claimFollowTargets, markFollowClaim } from "@/lib/workflows/follow-claims"

export type FollowMode = "follow" | "unfollow"

export interface FollowTargetOutcome {
  username: string
  status: "done" | "failed"
  reason?: string
  waited: boolean // whether the inter-action delay was applied after this target
}

export interface RunFollowTargetsResult {
  attempted: number
  succeeded: number
  failed: number
  outcomes: FollowTargetOutcome[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Execute the Follow / Unfollow Targets step for ONE account.
//
// Targets are claimed from the shared pool (divide-the-list), then processed
// one by one. The key behaviour requested: the inter-action delay is applied
// ONLY after a genuine, successful follow/unfollow. If a target is skipped
// (username can't be resolved) or the action itself fails, we move straight to
// the next target with no wait — the delay exists to pace real activity, so
// there's nothing to pace when nothing happened.
export async function runFollowTargetsForAccount(opts: {
  accountId: number
  jobId: number
  mode: FollowMode
  config: FollowTargetsConfig
  // Optional cooperative cancel — checked before each target.
  shouldStop?: () => boolean
  onOutcome?: (o: FollowTargetOutcome) => void
}): Promise<RunFollowTargetsResult> {
  const { accountId, jobId, mode, config, shouldStop, onOutcome } = opts
  const result: RunFollowTargetsResult = { attempted: 0, succeeded: 0, failed: 0, outcomes: [] }

  const account = await getAccountById(accountId)
  if (!account) return result

  // Claim this account's slice of the shared list (others skip these names).
  const targets = await claimFollowTargets(jobId, accountId, config.followsPerAccount)
  if (targets.length === 0) return result

  const c = new InstagramClient(account)
  const delayMs = Math.max(0, config.delaySec) * 1000

  for (let i = 0; i < targets.length; i++) {
    if (shouldStop?.()) break
    const username = targets[i]
    result.attempted++

    const record = (status: "done" | "failed", reason: string | undefined, waited: boolean) => {
      const outcome: FollowTargetOutcome = { username, status, reason, waited }
      result.outcomes.push(outcome)
      if (status === "done") result.succeeded++
      else result.failed++
      onOutcome?.(outcome)
      void markFollowClaim(jobId, username, status)
    }

    // 1. Resolve username -> pk. On failure, skip WITHOUT delay.
    let pk: string | undefined
    try {
      const res = await ep.resolveUsername(c, username)
      const raw = res.data?.user?.pk
      if (res.ok && raw != null) pk = String(raw)
    } catch {
      // fall through to the skip path below
    }
    if (!pk) {
      record("failed", "resolve_failed", false)
      continue // no delay on skip
    }

    // 2. Perform the follow / unfollow. On failure, continue WITHOUT delay.
    let ok = false
    try {
      if (mode === "unfollow") {
        // Mirror the real app: fire the informational chaining-count check first.
        await ep.unfollowChainingCount(c, pk).catch(() => {})
        ok = (await ep.unfollow(c, pk)).ok
      } else {
        ok = (await ep.follow(c, pk)).ok
      }
    } catch {
      ok = false
    }

    if (!ok) {
      record("failed", "action_failed", false)
      continue // no delay on failure
    }

    // 3. Success → pace before the next target (skip the wait after the last one).
    const isLast = i === targets.length - 1
    const willWait = delayMs > 0 && !isLast
    record("done", undefined, willWait)
    if (willWait) await sleep(delayMs)
  }

  return result
}
