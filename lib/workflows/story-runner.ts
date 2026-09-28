import { InstagramClient } from "@/lib/instagram/client"
import { publishStory, publishHighlight, type StoryMediaInput, type StoryLog } from "@/lib/instagram/story"
import { loadMediaBuffer } from "@/lib/media/storage"
import type { igAccounts } from "@/lib/db/schema"
import type { StoryAssignment, StoryLink, PostStoryConfig, CreateHighlightConfig } from "@/lib/workflows/types"

type Account = typeof igAccounts.$inferSelect

export interface StoryOutcome {
  accountId: number
  status: "done" | "skipped" | "failed"
  reason?: string
}

// Reads locally-stored media from disk (legacy absolute blob URLs still fetch
// over HTTP), since detached runners have no request origin.
async function fetchBuffer(url: string): Promise<Buffer> {
  return loadMediaBuffer(url)
}

// Build the media input + link sticker shared by both story and highlight runs.
async function prepare(assignment: StoryAssignment): Promise<{ media: StoryMediaInput; link: StoryLink } | null> {
  // Skip accounts with no media or no link URL.
  if (!assignment.mediaUrl || !assignment.link?.url?.trim()) return null
  const buffer = await fetchBuffer(assignment.mediaUrl)
  return {
    media: {
      buffer,
      kind: assignment.kind === "video" ? "video" : "image",
    },
    link: assignment.link,
  }
}

// Post Story for ONE account. Accounts without media or a link URL are skipped.
export async function runPostStoryForAccount(opts: {
  account: Account
  config: PostStoryConfig
  log?: StoryLog
}): Promise<StoryOutcome> {
  const { account, config, log } = opts
  const accountId = account.id
  const assignment = config.assignments.find((a) => a.accountId === accountId)
  if (!assignment) return { accountId, status: "skipped", reason: "no_assignment" }

  try {
    const prepared = await prepare(assignment)
    if (!prepared) return { accountId, status: "skipped", reason: "no_media_or_link" }
    const c = new InstagramClient(account)
    const res = await publishStory(c, prepared.media, prepared.link, log)
    return res.ok ? { accountId, status: "done" } : { accountId, status: "failed", reason: `http_${res.status}` }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "story_failed" }
  }
}

// Create Highlight for ONE account: posts the story, ensures it's archived, then
// builds a highlight named `highlightName`. Accounts without media/link skipped.
export async function runCreateHighlightForAccount(opts: {
  account: Account
  config: CreateHighlightConfig
  log?: StoryLog
}): Promise<StoryOutcome> {
  const { account, config, log } = opts
  const accountId = account.id
  const assignment = config.assignments.find((a) => a.accountId === accountId)
  if (!assignment) return { accountId, status: "skipped", reason: "no_assignment" }

  try {
    const prepared = await prepare(assignment)
    if (!prepared) return { accountId, status: "skipped", reason: "no_media_or_link" }
    const c = new InstagramClient(account)
    const res = await publishHighlight(
      c,
      prepared.media,
      {
        title: config.highlightName || "Highlights",
        link: prepared.link,
      },
      log,
    )
    return res.ok ? { accountId, status: "done" } : { accountId, status: "failed", reason: `http_${res.status}` }
  } catch (err) {
    return { accountId, status: "failed", reason: err instanceof Error ? err.message : "highlight_failed" }
  }
}
