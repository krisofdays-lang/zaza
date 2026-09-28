import { pgTable, serial, text, integer, timestamp, jsonb, bigint, boolean } from "drizzle-orm/pg-core"

// Application users. There is no self-registration: access is granted by a
// license_key that the owner provisions (manually or via the admin screen).
// Every data row is scoped to exactly one user via user_id.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  licenseKey: text("license_key").notNull().unique(),
  label: text("label").notNull().default(""),
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

// Instagram accounts and their per-account credentials / device settings.
export const igAccounts = pgTable("ig_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  label: text("label").notNull().default(""),
  username: text("username").notNull().default(""),
  // Account password and TOTP (2FA) seed, captured from the cookie blob. Kept
  // for the (not-yet-implemented) username/password login path and for issuing
  // 2FA codes; never sent as headers.
  password: text("password").notNull().default(""),
  totpSeed: text("totp_seed").notNull().default(""),
  igUserId: text("ig_user_id").notNull().default(""),
  bearerToken: text("bearer_token").notNull(),
  mid: text("mid").notNull().default(""),
  claim: text("claim").notNull().default("SKIP"),
  // Device identity taken VERBATIM from the account's cookie blob (never
  // synthesized). deviceId holds the blob `guid` (the _uuid / x-ig-device-id),
  // familyDeviceId holds `family_device_id` (x-ig-family-device-id) and phoneId
  // holds `phone_id` (the body phone_id field).
  deviceId: text("device_id").notNull().default(""),
  familyDeviceId: text("family_device_id").notNull().default(""),
  phoneId: text("phone_id").notNull().default(""),
  // The full decoded cookie blob (session + device + app + ua_profile +
  // cookies). Everything not promoted to its own column lives here so extra
  // identifiers (pigeon_session, fb_anon_id, waterfall_id, machine_id, csrf,
  // reg_flow_id, aac_jid, …) are available for any request that needs them.
  identity: jsonb("identity"),
  // Device attestation token (x-cloud-trust-token). Captured per account from a
  // real session; cannot be synthesized. Sent on every request like mid/claim.
  // Empty string = not captured, in which case we omit the header entirely.
  cloudTrustToken: text("cloud_trust_token").notNull().default(""),
  proxyType: text("proxy_type").notNull().default("none"), // none | http | socks5
  proxyUrl: text("proxy_url").notNull().default(""),
  rotationUrl: text("rotation_url").notNull().default(""),
  iphoneModel: text("iphone_model").notNull().default("iPhone17,1"),
  iosVersion: text("ios_version").notNull().default("18_5"),
  appVersion: text("app_version").notNull().default("437.0.0.22.50"),
  // Region fingerprint. `locale` (xx_YY) drives every locale header and the UA
  // locale; `timezone` (IANA zone) drives the x-ig-timezone-offset we send,
  // computed with DST. Set these per account to match its proxy's country.
  locale: text("locale").notNull().default("en_US"),
  timezone: text("timezone").notNull().default("Europe/Moscow"),
  userAgent: text("user_agent").notNull().default(""), // full built UA string
  status: text("status").notNull().default("idle"), // idle | ok | error | running
  lastError: text("last_error").notNull().default(""),
  profile: jsonb("profile"),
  // Ephemeral state for an in-progress UFAC checkpoint ("Challenge") resolution
  // flow. Carries what the next Bloks step needs between server actions:
  // challenge_root_id, persisted_data, contact_point, nav-chain, pigeon session,
  // current step, last captcha image URL, etc. Cleared when the flow finishes.
  challengeState: jsonb("challenge_state"),
  // Sum of play counts across the account's 6 most recent reels. Refreshed
  // whenever the profile is pulled (on add and on "Refresh profile").
  recentReelViews: integer("recent_reel_views"),
  lastCheckedAt: timestamp("last_checked_at"),
  // Timestamp of the last successful MEDIA publish (reel / post / carousel) for
  // this account, from either a workflow or a publication. Stories do NOT update
  // this. Shown in the dashboard accounts list.
  lastPostAt: timestamp("last_post_at"),
  // ── Anti-fingerprint isolation ──────────────────────────────────────
  // Per-account clock offset (ms). All client-facing timestamps (upload_id,
  // publish_id, client_timestamp, nav-chain) are generated as
  // Date.now() + clockOffsetMs so parallel accounts look like separate phones
  // with independently-drifting clocks. Range ±120 000 ms (±2 min), set once
  // at account creation and never changed.
  clockOffsetMs: integer("clock_offset_ms").notNull().default(0),
  // Hex-encoded 32-byte seed for a per-account PRNG. All random IDs
  // (waterfall_id, session_id, UUIDs, randomHex) are derived from this seed
  // so outputs from different accounts are cryptographically independent.
  // Set once at account creation from crypto.randomBytes(32).
  prngSeed: text("prng_seed").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// Groups of accounts with an attached workflow (ordered list of action steps).
export const igGroups = pgTable("ig_groups", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  workflow: jsonb("workflow").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// Membership join between groups and accounts.
export const igGroupAccounts = pgTable("ig_group_accounts", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull(),
  accountId: integer("account_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// Execution logs for every action that is run.
export const igRunLogs = pgTable("ig_run_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  accountId: integer("account_id"),
  groupId: integer("group_id"),
  action: text("action").notNull(),
  status: text("status").notNull().default("pending"), // pending | ok | error
  requestUrl: text("request_url").notNull().default(""),
  responseCode: integer("response_code"),
  message: text("message").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// Stored media uploaded to Blob, including uniqueized copies.
export const igMedia = pgTable("ig_media", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  name: text("name").notNull().default(""),
  kind: text("kind").notNull().default("image"), // image | video
  blobUrl: text("blob_url").notNull(),
  pathname: text("pathname").notNull().default(""),
  contentType: text("content_type").notNull().default(""),
  size: bigint("size", { mode: "number" }).notNull().default(0),
  // SHA-256 of the file bytes, used to deduplicate identical uploads so the
  // same reel attached to several Post Reel steps is stored only once.
  contentHash: text("content_hash").notNull().default(""),
  width: integer("width"),
  height: integer("height"),
  sourceId: integer("source_id"), // parent media this was uniqueized from
  isUnique: boolean("is_unique").notNull().default(false),
  // User-editable label/note shown in the library.
  label: text("label").notNull().default(""),
  // Set to an account id once this exact file has been published for that
  // account. Uniqueized copies are fresh rows, so they start unmarked and only
  // become "used" when they themselves get published.
  usedByAccountId: integer("used_by_account_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// Publication jobs (reel / post / story / highlight) targeting accounts or groups.
export const igPublications = pgTable("ig_publications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  type: text("type").notNull().default("post"), // reel | post | story | highlight
  caption: text("caption").notNull().default(""),
  groupId: integer("group_id"),
  accountIds: jsonb("account_ids").notNull().default([]),
  assignments: jsonb("assignments").notNull().default([]), // [{ accountId, mediaId }]
  linkSticker: jsonb("link_sticker"),
  status: text("status").notNull().default("draft"), // draft | running | done | error
  result: jsonb("result"),
  // How many accounts publish in parallel (1 = sequential, up to 20). Null falls
  // back to the runner default.
  concurrency: integer("concurrency"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// Cached analytics snapshots. The most recent row is shown instantly on the
// Analytics page so we never hit the private API just to render the section.
export const igAnalyticsSnapshots = pgTable("ig_analytics_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  data: jsonb("data").notNull(), // serialized AnalyticsResult
  accountsCount: integer("accounts_count").notNull().default(0),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
})

// Background refresh jobs that pull live reel data. Progress is persisted so the
// UI can poll status and so a dead/stale job can be detected and superseded.
export const igAnalyticsJobs = pgTable("ig_analytics_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  status: text("status").notNull().default("running"), // running | done | error
  total: integer("total").notNull().default(0),
  processed: integer("processed").notNull().default(0),
  currentLabel: text("current_label").notNull().default(""),
  phase: text("phase").notNull().default(""), // e.g. rotating | fetching | waiting
  accountIds: jsonb("account_ids").notNull().default([]),
  error: text("error").notNull().default(""),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
})

// Warm up background jobs (Feed Scroll, Reels Scroll, Feed Training, Stories
// Tracker). Each job scrolls the feed for the selected accounts for a fixed
// duration, performing like/repost/save/follow at the configured probabilities.
export const igWarmupJobs = pgTable("ig_warmup_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  kind: text("kind").notNull().default("feed_scroll"), // feed_scroll | reels_scroll | feed_training | stories_tracker
  status: text("status").notNull().default("queued"), // queued | running | done | error | cancelled
  groupId: integer("group_id"),
  accountIds: jsonb("account_ids").notNull().default([]),
  config: jsonb("config").notNull().default({}), // { like, repost, save, follow, durationMin }
  // How many accounts (proxy lanes) run in parallel (1 = sequential, up to 20).
  concurrency: integer("concurrency"),
  total: integer("total").notNull().default(0),
  processed: integer("processed").notNull().default(0),
  actionsCount: integer("actions_count").notNull().default(0),
  currentLabel: text("current_label").notNull().default(""),
  phase: text("phase").notNull().default(""),
  error: text("error").notNull().default(""),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
})

// Follow Targets coordination. When a Follow Targets step runs, its username
// list is seeded here (one row per username, scoped to a run via jobId). Each
// account atomically claims a batch of still-"pending" rows (FOR UPDATE SKIP
// LOCKED), so within a run no two accounts ever follow the same username — the
// list is divided across accounts rather than repeated.
export const igFollowClaims = pgTable("ig_follow_claims", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull(),
  username: text("username").notNull(),
  accountId: integer("account_id"), // which account claimed it (null while pending)
  status: text("status").notNull().default("pending"), // pending | claimed | done | failed
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

export type IgFollowClaim = typeof igFollowClaims.$inferSelect

// A saved Workflow: the editor graph plus its live run state in one row. A
// workflow has at most one active run at a time, so run state lives inline
// (mirrors the warmup-job model). Per-account/action activity is written to the
// shared ig_run_logs table and surfaced in the editor's Live Logs.
export const igWorkflows = pgTable("ig_workflows", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  name: text("name").notNull().default("Untitled Workflow"),
  // { nodes, edges } from React Flow, including the Start node's config
  // (delayMs, naturalBehavior). Defaults to an empty graph.
  graph: jsonb("graph").notNull().default({ nodes: [], edges: [] }),
  accountIds: jsonb("account_ids").notNull().default([]),
  status: text("status").notNull().default("draft"), // draft | running | done | error | cancelled
  total: integer("total").notNull().default(0), // accounts in the run
  processed: integer("processed").notNull().default(0), // accounts fully finished
  actionsCount: integer("actions_count").notNull().default(0),
  // Aggregate per-node progress: Record<nodeId, { done, total }>.
  progress: jsonb("progress").notNull().default({}),
  currentNodeId: text("current_node_id").notNull().default(""),
  currentLabel: text("current_label").notNull().default(""), // active account handle
  phase: text("phase").notNull().default(""),
  error: text("error").notNull().default(""),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
})

export type IgWorkflow = typeof igWorkflows.$inferSelect
export type NewIgWorkflow = typeof igWorkflows.$inferInsert

export type IgWarmupJob = typeof igWarmupJobs.$inferSelect

export type IgAnalyticsSnapshot = typeof igAnalyticsSnapshots.$inferSelect
export type IgAnalyticsJob = typeof igAnalyticsJobs.$inferSelect

// ── Auto-registration ────────────────────────────────────────────────────
// Accounts created by the built-in autoreg engine. They live in a separate
// holding table until an admin transfers them to a platform user.
export const igAutoregAccounts = pgTable("ig_autoreg_accounts", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  password: text("password").notNull().default(""),
  totpSeed: text("totp_seed").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  igUserId: text("ig_user_id").notNull().default(""),
  bearerToken: text("bearer_token").notNull().default(""),
  mid: text("mid").notNull().default(""),
  claim: text("claim").notNull().default(""),
  dsUserId: text("ds_user_id").notNull().default(""),
  csrf: text("csrf").notNull().default(""),
  rur: text("rur").notNull().default(""),
  // Device identifiers
  deviceId: text("device_id").notNull().default(""),        // guid / _uuid
  familyDeviceId: text("family_device_id").notNull().default(""),
  phoneId: text("phone_id").notNull().default(""),
  pigeonSession: text("pigeon_session").notNull().default(""),
  fbAnonId: text("fb_anon_id").notNull().default(""),
  waterfallId: text("waterfall_id").notNull().default(""),
  machineId: text("machine_id").notNull().default(""),
  cloudTrustToken: text("cloud_trust_token").notNull().default(""),
  aacJid: text("aac_jid").notNull().default(""),
  aacCs: text("aac_cs").notNull().default(""),
  // Device fingerprint
  iphoneModel: text("iphone_model").notNull().default(""),
  iosVersion: text("ios_version").notNull().default(""),
  appVersion: text("app_version").notNull().default(""),
  locale: text("locale").notNull().default("en_US"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  userAgent: text("user_agent").notNull().default(""),
  // The full session blob (JSON) that gets base64-encoded for export
  sessionBlob: jsonb("session_blob"),
  // Proxy used during registration
  proxyUrl: text("proxy_url").notNull().default(""),
  // Registration method (email | sms)
  regMethod: text("reg_method").notNull().default("email"),
  // Group label for batch organization
  groupLabel: text("group_label").notNull().default(""),
  // Status: created | transferred | banned
  status: text("status").notNull().default("created"),
  // Transferred to which platform user / account
  transferredToUserId: integer("transferred_to_user_id"),
  transferredToAccountId: integer("transferred_to_account_id"),
  transferredAt: timestamp("transferred_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

// Execution log for autoreg attempts: one row per attempt with full status.
export const igAutoregLogs = pgTable("ig_autoreg_logs", {
  id: serial("id").primaryKey(),
  // Job-level grouping: all attempts from one "Start" click share a jobId.
  jobId: text("job_id").notNull(),
  threadIndex: integer("thread_index").notNull().default(0),
  username: text("username").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  proxy: text("proxy").notNull().default(""),
  method: text("method").notNull().default("email"), // email | sms
  step: text("step").notNull().default(""),           // current step name
  stepDetail: text("step_detail").notNull().default(""), // current step detail/progress info
  status: text("status").notNull().default("running"), // running | success | error | cancelled
  error: text("error").notNull().default(""),
  // Created autoreg account id on success
  autoregAccountId: integer("autoreg_account_id"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
})

// Active autoreg job state (at most one running at a time).
export const igAutoregJobs = pgTable("ig_autoreg_jobs", {
  id: serial("id").primaryKey(),
  jobId: text("job_id").notNull().unique(),
  status: text("status").notNull().default("running"), // running | done | error | cancelled
  method: text("method").notNull().default("email"),
  threads: integer("threads").notNull().default(1),
  targetCount: integer("target_count").notNull().default(1),
  completed: integer("completed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  config: jsonb("config").notNull().default({}), // API keys, proxy list, etc.
  error: text("error").notNull().default(""),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
})

export type IgAutoregAccount = typeof igAutoregAccounts.$inferSelect
export type NewIgAutoregAccount = typeof igAutoregAccounts.$inferInsert
export type IgAutoregLog = typeof igAutoregLogs.$inferSelect
export type IgAutoregJob = typeof igAutoregJobs.$inferSelect

export type IgAccount = typeof igAccounts.$inferSelect
export type NewIgAccount = typeof igAccounts.$inferInsert
export type IgGroup = typeof igGroups.$inferSelect
export type IgRunLog = typeof igRunLogs.$inferSelect
export type IgMedia = typeof igMedia.$inferSelect
export type IgPublication = typeof igPublications.$inferSelect
