-- Autoreg tables migration
-- Run this against your PostgreSQL database to create the autoreg tables.

CREATE TABLE IF NOT EXISTS ig_autoreg_accounts (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  password TEXT NOT NULL DEFAULT '',
  totp_seed TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  ig_user_id TEXT NOT NULL DEFAULT '',
  bearer_token TEXT NOT NULL DEFAULT '',
  mid TEXT NOT NULL DEFAULT '',
  claim TEXT NOT NULL DEFAULT '',
  ds_user_id TEXT NOT NULL DEFAULT '',
  csrf TEXT NOT NULL DEFAULT '',
  rur TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  family_device_id TEXT NOT NULL DEFAULT '',
  phone_id TEXT NOT NULL DEFAULT '',
  pigeon_session TEXT NOT NULL DEFAULT '',
  fb_anon_id TEXT NOT NULL DEFAULT '',
  waterfall_id TEXT NOT NULL DEFAULT '',
  machine_id TEXT NOT NULL DEFAULT '',
  cloud_trust_token TEXT NOT NULL DEFAULT '',
  aac_jid TEXT NOT NULL DEFAULT '',
  aac_cs TEXT NOT NULL DEFAULT '',
  iphone_model TEXT NOT NULL DEFAULT '',
  ios_version TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'en_US',
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  user_agent TEXT NOT NULL DEFAULT '',
  session_blob JSONB,
  proxy_url TEXT NOT NULL DEFAULT '',
  reg_method TEXT NOT NULL DEFAULT 'email',
  group_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'created',
  transferred_to_user_id INTEGER,
  transferred_to_account_id INTEGER,
  transferred_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ig_autoreg_logs (
  id SERIAL PRIMARY KEY,
  job_id TEXT NOT NULL,
  thread_index INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  proxy TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'email',
  step TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT NOT NULL DEFAULT '',
  autoreg_account_id INTEGER,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ig_autoreg_jobs (
  id SERIAL PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'running',
  method TEXT NOT NULL DEFAULT 'email',
  threads INTEGER NOT NULL DEFAULT 1,
  target_count INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_autoreg_accounts_status ON ig_autoreg_accounts(status);
CREATE INDEX IF NOT EXISTS idx_autoreg_logs_job_id ON ig_autoreg_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_autoreg_jobs_status ON ig_autoreg_jobs(status);
