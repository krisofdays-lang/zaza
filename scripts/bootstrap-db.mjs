// Idempotent database bootstrap. Safe to run on every container start: it only
// CREATEs/ALTERs with IF NOT EXISTS and seeds the owner user. It NEVER drops or
// truncates anything, so deploys/updates never lose data.
//
// Run manually:  node scripts/bootstrap-db.mjs
// On deploy:     invoked by the Docker entrypoint before `next start`.

import pg from "pg"

const { Pool } = pg

const OWNER_LICENSE_KEY = process.env.OWNER_LICENSE_KEY || "a4726d28-30f2-b4aa-5643-adc4c88f0606"

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error("[bootstrap] DATABASE_URL is not set")
  process.exit(1)
}

// Match the runtime SSL behaviour (lib/db/index.ts): opt-in via DATABASE_SSL.
const sslEnv = (process.env.DATABASE_SSL || "").toLowerCase()
const ssl =
  sslEnv === "require" || sslEnv === "true" || sslEnv === "1"
    ? { rejectUnauthorized: false }
    : sslEnv === "disable" || sslEnv === "false" || sslEnv === "0"
      ? false
      : /\bsslmode=require\b/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined

const pool = new Pool({ connectionString, ssl })

// Every data table that must be scoped to a user.
const SCOPED_TABLES = [
  "ig_accounts",
  "ig_groups",
  "ig_run_logs",
  "ig_media",
  "ig_publications",
  "ig_analytics_snapshots",
  "ig_analytics_jobs",
  "ig_warmup_jobs",
  "ig_workflows",
]

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  license_key text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '',
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_accounts (
  id serial PRIMARY KEY,
  label text NOT NULL DEFAULT '',
  username text NOT NULL DEFAULT '',
  ig_user_id text NOT NULL DEFAULT '',
  bearer_token text NOT NULL,
  mid text NOT NULL DEFAULT '',
  claim text NOT NULL DEFAULT 'SKIP',
  device_id text NOT NULL DEFAULT '',
  family_device_id text NOT NULL DEFAULT '',
  proxy_type text NOT NULL DEFAULT 'none',
  proxy_url text NOT NULL DEFAULT '',
  rotation_url text NOT NULL DEFAULT '',
  iphone_model text NOT NULL DEFAULT 'iPhone11,8',
  ios_version text NOT NULL DEFAULT '15_3_1',
  app_version text NOT NULL DEFAULT '410.1.0.36.70',
  locale text NOT NULL DEFAULT 'en_US',
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  user_agent text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'idle',
  last_error text NOT NULL DEFAULT '',
  profile jsonb,
  recent_reel_views integer,
  last_checked_at timestamptz,
  last_post_at timestamptz,
  clock_offset_ms integer NOT NULL DEFAULT 0,
  prng_seed text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_groups (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  workflow jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_group_accounts (
  id serial PRIMARY KEY,
  group_id integer NOT NULL,
  account_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_run_logs (
  id serial PRIMARY KEY,
  account_id integer,
  group_id integer,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  request_url text NOT NULL DEFAULT '',
  response_code integer,
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_media (
  id serial PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'image',
  blob_url text NOT NULL,
  pathname text NOT NULL DEFAULT '',
  content_type text NOT NULL DEFAULT '',
  size bigint NOT NULL DEFAULT 0,
  content_hash text NOT NULL DEFAULT '',
  width integer,
  height integer,
  source_id integer,
  is_unique boolean NOT NULL DEFAULT false,
  label text NOT NULL DEFAULT '',
  used_by_account_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_publications (
  id serial PRIMARY KEY,
  type text NOT NULL DEFAULT 'post',
  caption text NOT NULL DEFAULT '',
  group_id integer,
  account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  assignments jsonb NOT NULL DEFAULT '[]'::jsonb,
  link_sticker jsonb,
  status text NOT NULL DEFAULT 'draft',
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_analytics_snapshots (
  id serial PRIMARY KEY,
  data jsonb NOT NULL,
  accounts_count integer NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_analytics_jobs (
  id serial PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  current_label text NOT NULL DEFAULT '',
  phase text NOT NULL DEFAULT '',
  account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS ig_warmup_jobs (
  id serial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'feed_scroll',
  status text NOT NULL DEFAULT 'queued',
  group_id integer,
  account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  actions_count integer NOT NULL DEFAULT 0,
  current_label text NOT NULL DEFAULT '',
  phase text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  cancel_requested boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS ig_follow_claims (
  id serial PRIMARY KEY,
  job_id integer NOT NULL,
  username text NOT NULL,
  account_id integer,
  status text NOT NULL DEFAULT 'pending',
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_workflows (
  id serial PRIMARY KEY,
  name text NOT NULL DEFAULT 'Untitled Workflow',
  graph jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  actions_count integer NOT NULL DEFAULT 0,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_node_id text NOT NULL DEFAULT '',
  current_label text NOT NULL DEFAULT '',
  phase text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS ig_autoreg_accounts (
  id serial PRIMARY KEY,
  username text NOT NULL,
  password text NOT NULL DEFAULT '',
  totp_seed text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  ig_user_id text NOT NULL DEFAULT '',
  bearer_token text NOT NULL DEFAULT '',
  mid text NOT NULL DEFAULT '',
  claim text NOT NULL DEFAULT '',
  ds_user_id text NOT NULL DEFAULT '',
  csrf text NOT NULL DEFAULT '',
  rur text NOT NULL DEFAULT '',
  device_id text NOT NULL DEFAULT '',
  family_device_id text NOT NULL DEFAULT '',
  phone_id text NOT NULL DEFAULT '',
  pigeon_session text NOT NULL DEFAULT '',
  fb_anon_id text NOT NULL DEFAULT '',
  waterfall_id text NOT NULL DEFAULT '',
  machine_id text NOT NULL DEFAULT '',
  cloud_trust_token text NOT NULL DEFAULT '',
  aac_jid text NOT NULL DEFAULT '',
  aac_cs text NOT NULL DEFAULT '',
  iphone_model text NOT NULL DEFAULT '',
  ios_version text NOT NULL DEFAULT '',
  app_version text NOT NULL DEFAULT '',
  locale text NOT NULL DEFAULT 'en_US',
  timezone text NOT NULL DEFAULT 'America/Chicago',
  user_agent text NOT NULL DEFAULT '',
  session_blob jsonb,
  proxy_url text NOT NULL DEFAULT '',
  reg_method text NOT NULL DEFAULT 'email',
  group_label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'created',
  transferred_to_user_id integer,
  transferred_to_account_id integer,
  transferred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ig_autoreg_logs (
  id serial PRIMARY KEY,
  job_id text NOT NULL,
  thread_index integer NOT NULL DEFAULT 0,
  username text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  proxy text NOT NULL DEFAULT '',
  method text NOT NULL DEFAULT 'email',
  step text NOT NULL DEFAULT '',
  step_detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'running',
  error text NOT NULL DEFAULT '',
  autoreg_account_id integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS ig_autoreg_jobs (
  id serial PRIMARY KEY,
  job_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'running',
  method text NOT NULL DEFAULT 'email',
  threads integer NOT NULL DEFAULT 1,
  target_count integer NOT NULL DEFAULT 1,
  completed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}',
  error text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_autoreg_accounts_status ON ig_autoreg_accounts(status);
CREATE INDEX IF NOT EXISTS idx_autoreg_logs_job_id ON ig_autoreg_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_autoreg_jobs_status ON ig_autoreg_jobs(status);
`

async function main() {
  const client = await pool.connect()
  try {
    // Serialize bootstrap across replicas. When several app replicas boot at
    // once (e.g. during a rolling update) they would otherwise run the same
    // CREATE/ALTER concurrently and can deadlock. A session-level advisory lock
    // makes the others wait; since the DDL is idempotent, the followers simply
    // find everything already in place. The lock auto-releases on disconnect.
    console.log("[bootstrap] acquiring bootstrap lock…")
    await client.query("SELECT pg_advisory_lock(hashtext('ig-tool-bootstrap'));")

    console.log("[bootstrap] ensuring tables exist…")
    await client.query(DDL)

    // Add user_id to every scoped table if it's missing (covers upgrades from
    // the pre-auth schema). Older rows keep user_id = NULL until claimed below.
    for (const table of SCOPED_TABLES) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS user_id integer;`)
    }

  // Reel-views column for the dashboard (covers upgrades from before it existed).
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS recent_reel_views integer;`)

  // Last successful media publish timestamp (reel/post/carousel; not stories).
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS last_post_at timestamptz;`)

  // Per-account region fingerprint (locale + IANA timezone). Older rows default
  // to the previous hardcoded behaviour (en_US + Moscow) so nothing shifts
  // until each account is set to match its proxy's country.
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en_US';`)
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Moscow';`)

  // Media library: editable label + "used by account" marker.
  await client.query(`ALTER TABLE ig_media ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';`)
  await client.query(`ALTER TABLE ig_media ADD COLUMN IF NOT EXISTS used_by_account_id integer;`)

  // Content hash (SHA-256) for upload deduplication, plus a lookup index so the
  // "does this file already exist for this user?" check on every upload is fast.
  await client.query(`ALTER TABLE ig_media ADD COLUMN IF NOT EXISTS content_hash text NOT NULL DEFAULT '';`)
  await client.query(
    `CREATE INDEX IF NOT EXISTS ig_media_user_hash_idx ON ig_media (user_id, content_hash);`,
  )

  // Device attestation token (x-cloud-trust-token), captured per account.
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS cloud_trust_token text NOT NULL DEFAULT '';`)

  // Cookie-blob account identity: credentials, the body phone_id, and the full
  // decoded blob (device + session + ua_profile). Added for the base64-cookie
  // add flow; older accounts keep empty defaults.
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS password text NOT NULL DEFAULT '';`)
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS totp_seed text NOT NULL DEFAULT '';`)
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS phone_id text NOT NULL DEFAULT '';`)
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS identity jsonb;`)
  // Ephemeral in-progress UFAC ("Challenge") resolution state.
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS challenge_state jsonb;`)

  // Per-account anti-fingerprint isolation: virtual clock offset and PRNG seed.
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS clock_offset_ms integer NOT NULL DEFAULT 0;`)
  await client.query(`ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS prng_seed text NOT NULL DEFAULT '';`)

  // Autoreg log step detail (progress info separate from error messages).
  await client.query(`ALTER TABLE ig_autoreg_logs ADD COLUMN IF NOT EXISTS step_detail text NOT NULL DEFAULT '';`)

  // Per-user autoreg settings (API keys, domains, etc.).
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS autoreg_settings jsonb;`)

    // Per-run concurrency (how many accounts run in parallel). Warm up and
    // publications store it on their job row; workflows store it on the Start
    // node inside the graph. Covers upgrades from before the setting existed.
    await client.query(`ALTER TABLE ig_warmup_jobs ADD COLUMN IF NOT EXISTS concurrency integer;`)
    await client.query(`ALTER TABLE ig_publications ADD COLUMN IF NOT EXISTS concurrency integer;`)

    // Seed the owner. ON CONFLICT keeps an existing row but guarantees admin.
    console.log(`[bootstrap] ensuring owner ${OWNER_LICENSE_KEY}…`)
    const ownerRes = await client.query(
      `INSERT INTO users (license_key, label, is_admin)
       VALUES ($1, 'Owner', true)
       ON CONFLICT (license_key) DO UPDATE SET is_admin = true
       RETURNING id;`,
      [OWNER_LICENSE_KEY],
    )
    const ownerId = ownerRes.rows[0].id

    // Claim any legacy/unscoped rows for the owner so existing data stays visible.
    let claimed = 0
    for (const table of SCOPED_TABLES) {
      const res = await client.query(`UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL;`, [ownerId])
      claimed += res.rowCount || 0
    }
    console.log(`[bootstrap] owner id=${ownerId}, assigned ${claimed} legacy row(s)`)
    console.log("[bootstrap] done.")
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error("[bootstrap] failed:", err)
  process.exit(1)
})
