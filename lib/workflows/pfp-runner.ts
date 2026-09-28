import { getAccountById } from "@/lib/data/accounts"
import { InstagramClient } from "@/lib/instagram/client"
import * as ep from "@/lib/instagram/endpoints"
import { loadMediaBuffer } from "@/lib/media/storage"
import type { ProfilePictureConfig } from "@/lib/workflows/types"

export interface PfpOutcome {
  accountId: number
  status: "done" | "skipped" | "failed"
  reason?: string
}

// Execute the Profile Picture step for ONE account.
//
// Mirrors the captured two-request flow:
//   1) rupload_igphoto (c.uploadPhoto) — upload the image bytes, get upload_id,
//   2) POST /accounts/change_profile_picture/ — apply it with that upload_id.
// Accounts with no image configured are skipped.
export async function runProfilePictureForAccount(opts: {
  accountId: number
  config: ProfilePictureConfig
}): Promise<PfpOutcome> {
  const { accountId, config } = opts
  const assignment = config.assignments.find((a) => a.accountId === accountId)
  const mediaUrl = assignment?.mediaUrl

  if (!assignment?.mediaId || !mediaUrl) return { accountId, status: "skipped", reason: "no_image" }

  const account = await getAccountById(accountId)
  if (!account) return { accountId, status: "failed", reason: "account_not_found" }

  // Load the image bytes. This reads local /api/media/<userId>/<file> straight
  // from disk (the detached runner has no request origin to fetch a relative
  // URL) and still supports legacy absolute http blob URLs.
  let buffer: Buffer
  try {
    buffer = await loadMediaBuffer(mediaUrl)
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "fetch_failed" }
  }

  const c = new InstagramClient(account)
  try {
    // 1. Upload the photo to get an upload_id.
    const upload = await c.uploadPhoto(buffer)
    if (!upload.ok || !upload.uploadId) return { accountId, status: "failed", reason: `upload_${upload.status}` }

    // 2. Apply it as the profile picture.
    const res = await ep.changeProfilePicture(c, upload.uploadId)
    const ok = res.ok && res.data?.status !== "fail"
    return ok ? { accountId, status: "done" } : { accountId, status: "failed", reason: `http_${res.status}` }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "change_failed" }
  }
}
