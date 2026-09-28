// Shared types for the workflow editor's per-node configuration. Each node
// stores its filled-in Edit Step data on `node.data.config`, which is what gets
// deep-cloned when a node is duplicated (so copies carry their files too).

// Lightweight shapes passed from the server into the client editor.
export interface WfAccount {
  id: number
  label: string
  username: string
  // Proxy info used by the run engine to group accounts and decide rotation.
  // Accounts sharing a proxyUrl run on the same proxy; a non-empty rotationUrl
  // means the proxy is rotated before each account and cooled down between them.
  proxyUrl?: string
  rotationUrl?: string
}

export interface WfMedia {
  id: number
  name: string
  kind: string // "image" | "video"
  blobUrl: string
  // Which account this file is used by, if any. Powers the "only media from
  // this account" filter in the workflow storage pickers.
  usedByAccountId?: number | null
}

// Post Reel: one assignment per account so we know which reel (and caption)
// belongs to which account. Media is referenced by its library id + url, so
// duplicating a node copies the reference rather than re-uploading the file.
export interface ReelAssignment {
  accountId: number
  mediaId: number | null
  mediaUrl: string | null
  mediaName: string | null
  description: string
  // Set when the reel was chosen via "Upload bunch" and is not yet uploaded.
  // References a file in the client-only pending-uploads registry; resolved to a
  // real mediaId/mediaUrl right before the workflow runs.
  pendingKey?: string | null
}

export interface PostReelConfig {
  assignments: ReelAssignment[]
}

export function emptyPostReelConfig(): PostReelConfig {
  return { assignments: [] }
}

// Post Media: like Post Reel, but each account can carry MULTIPLE photos/videos
// (up to 20). A single item posts as a normal photo/reel; 2+ items post as a
// carousel via /media/configure_sidecar/. Media is referenced by library id +
// url so duplicating a node copies the references rather than re-uploading.
export interface MediaItemRef {
  mediaId: number
  mediaUrl: string
  mediaName: string
  kind: string // "image" | "video"
  // Set when this item was chosen via "Upload bunch" and is not yet uploaded.
  // Pending items carry mediaId 0 and an empty mediaUrl until resolved to a real
  // storage id/url right before the workflow runs.
  pendingKey?: string | null
}

export interface MediaAssignment {
  accountId: number
  items: MediaItemRef[]
  description: string
}

export interface PostMediaConfig {
  assignments: MediaAssignment[]
}

export function emptyPostMediaConfig(): PostMediaConfig {
  return { assignments: [] }
}

export const MAX_CAROUSEL_ITEMS = 20

// Follow Targets: how many follows each account performs, the delay between
// follows (seconds), and the list of target usernames to follow.
export interface FollowTargetsConfig {
  followsPerAccount: number
  delaySec: number
  usernames: string[]
}

export function emptyFollowTargetsConfig(): FollowTargetsConfig {
  return { followsPerAccount: 20, delaySec: 60, usernames: [] }
}

// Account Privacy: the step runs for every account in the workflow. Each
// account has a toggle — ON = private (set_bool value:true), OFF = public
// (set_bool value:false). Toggles default ON, so we persist only the account
// ids switched to public; newly added accounts default to private.
export interface AccountPrivacyConfig {
  publicAccountIds: number[]
}

export function emptyAccountPrivacyConfig(): AccountPrivacyConfig {
  return { publicAccountIds: [] }
}

// Biography Change: per-account bio text. The step runs for every account; each
// can have its own new biography (supports \n and emoji). Accounts with an empty
// bio entry are skipped. Keyed by account id so it survives account reordering.
export interface BioChangeConfig {
  bios: Record<number, string>
}

export function emptyBioChangeConfig(): BioChangeConfig {
  return { bios: {} }
}

// Name Change: per-account display name (first_name). Runs for every account;
// blank entries are skipped. An autofill button fills every field with a random
// US female name. Keyed by account id so it survives account reordering.
export interface NameChangeConfig {
  names: Record<number, string>
}

export function emptyNameChangeConfig(): NameChangeConfig {
  return { names: {} }
}

// Curated list of common US female names, used by the Name Change autofill.
const US_FEMALE_NAMES = [
  "Olivia", "Emma", "Charlotte", "Amelia", "Sophia", "Isabella", "Ava", "Mia",
  "Evelyn", "Luna", "Harper", "Camila", "Sofia", "Scarlett", "Elizabeth", "Ella",
  "Chloe", "Grace", "Victoria", "Riley", "Aria", "Lily", "Aurora", "Zoey",
  "Hannah", "Lillian", "Addison", "Natalie", "Leah", "Hazel", "Violet", "Aaliyah",
  "Savannah", "Audrey", "Brooklyn", "Bella", "Claire", "Skylar", "Lucy", "Paisley",
  "Stella", "Nora", "Maya", "Madison", "Layla", "Penelope", "Nova", "Ellie",
]

// Pick a random US female name (optionally avoiding a set already in use).
export function randomFemaleName(exclude?: Set<string>): string {
  const pool = exclude ? US_FEMALE_NAMES.filter((n) => !exclude.has(n)) : US_FEMALE_NAMES
  const list = pool.length > 0 ? pool : US_FEMALE_NAMES
  return list[Math.floor(Math.random() * list.length)]
}

// Username Change: per-account new username. Runs for every account; blank
// entries are skipped (no requests fire for that account). Keyed by account id
// so the mapping survives account reordering.
export interface UsernameChangeConfig {
  usernames: Record<number, string>
}

export function emptyUsernameChangeConfig(): UsernameChangeConfig {
  return { usernames: {} }
}

// Link in Bio: per-account external link URL. Runs for every account; blank
// entries are skipped (no requests fire for that account). Keyed by account id.
export interface LinkInBioConfig {
  links: Record<number, string>
}

export function emptyLinkInBioConfig(): LinkInBioConfig {
  return { links: {} }
}

// Profile Picture: one image assignment per account (no caption). Like Post Reel
// but the media must be an image. Accounts without an image are skipped.
export interface PfpAssignment {
  accountId: number
  mediaId: number | null
  mediaUrl: string | null
  mediaName: string | null
}

export interface ProfilePictureConfig {
  assignments: PfpAssignment[]
}

export function emptyProfilePictureConfig(): ProfilePictureConfig {
  return { assignments: [] }
}

// Post Story / Create Highlight: one assignment per account. Each carries a
// single media reference plus a link sticker. The link URL is required — an
// account with no media or no link URL is skipped. Create Highlight additionally
// posts the story to the archive and builds a highlight named `highlightName`.
export interface StoryLink {
  url: string
  text?: string
  rotation?: number // degrees
  size?: number // percent
  x?: number // normalized centre 0–1
  y?: number // normalized centre 0–1
}

export interface StoryAssignment {
  accountId: number
  mediaId: number | null
  mediaUrl: string | null
  mediaName: string | null
  kind: string | null // "image" | "video"
  link: StoryLink
  // Set when the media was chosen via "Upload bunch" and is not yet uploaded.
  // Resolved to a real mediaId/mediaUrl right before the workflow runs.
  pendingKey?: string | null
}

export function emptyStoryLink(): StoryLink {
  return { url: "", text: "", rotation: 0, size: 100, x: 0.5, y: 0.76 }
}

export interface PostStoryConfig {
  assignments: StoryAssignment[]
}

export function emptyPostStoryConfig(): PostStoryConfig {
  return { assignments: [] }
}

export interface CreateHighlightConfig {
  assignments: StoryAssignment[]
  highlightName: string
}

export function emptyCreateHighlightConfig(): CreateHighlightConfig {
  return { assignments: [], highlightName: "" }
}

// Parse a free-form textarea (newlines, commas, spaces, optional @) into a
// clean, de-duplicated list of usernames.
export function parseUsernames(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tok of raw.split(/[\s,]+/)) {
    const u = tok.trim().replace(/^@+/, "").toLowerCase()
    if (u && !seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
}
