-- Gateway schema. Applied at boot with CREATE TABLE IF NOT EXISTS
-- (no migration tool — additive changes only; version pinned in schema_version).
CREATE TABLE IF NOT EXISTS schema_version (v int PRIMARY KEY, applied_at timestamptz DEFAULT now());
INSERT INTO schema_version (v) VALUES (1) ON CONFLICT DO NOTHING;

-- Settled-call receipts (replaces in-memory log; feeds stats + spend caps).
CREATE TABLE IF NOT EXISTS receipts (
  id text PRIMARY KEY,
  ts bigint NOT NULL,
  model text NOT NULL DEFAULT '',
  host text NOT NULL DEFAULT '',
  payer text NOT NULL DEFAULT '',
  "user" text NOT NULL DEFAULT '',
  price_wei text NOT NULL DEFAULT '0',
  amount_credits text NOT NULL DEFAULT '0',
  prompt_hash text NOT NULL DEFAULT '',
  completion_hash text NOT NULL DEFAULT '',
  model_digest text NOT NULL DEFAULT '',
  receipt_hash text NOT NULL DEFAULT '',
  debit_tx text,
  hcs_seq bigint,
  host_share text NOT NULL DEFAULT '0',
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS receipts_ts_idx ON receipts (ts DESC);
CREATE INDEX IF NOT EXISTS receipts_payer_idx ON receipts (payer, ts DESC);

-- API keys (restart-safe issuance + revocation).
CREATE TABLE IF NOT EXISTS api_keys (
  prefix text PRIMARY KEY,
  key_hash text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint,
  scopes jsonb NOT NULL DEFAULT '{}',
  revoked boolean NOT NULL DEFAULT false
);

-- Member spend caps (admin-set; fail-closed when present).
CREATE TABLE IF NOT EXISTS spend_caps (
  prefix text PRIMARY KEY,
  cap double precision NOT NULL,
  period_start bigint NOT NULL
);

-- Host metadata: self-reported regions + owner claims (login-linked dashboards).
CREATE TABLE IF NOT EXISTS host_meta (
  address text PRIMARY KEY,
  region text,
  owner_user_id text
);
CREATE INDEX IF NOT EXISTS host_meta_owner_idx ON host_meta (owner_user_id);
ALTER TABLE host_meta ADD COLUMN IF NOT EXISTS geo text;
ALTER TABLE host_meta ADD COLUMN IF NOT EXISTS geo_at bigint;

-- Device-code login (CLI link flow, 10-min TTL).
CREATE TABLE IF NOT EXISTS device_codes (
  code text PRIMARY KEY,
  user_id text,
  token text,
  expires_at bigint NOT NULL
);

-- Verification reports (cheat-host memory survives restarts).
CREATE TABLE IF NOT EXISTS verify_reports (
  host text NOT NULL,
  ts bigint NOT NULL,
  model_id text NOT NULL DEFAULT '',
  passed int NOT NULL DEFAULT 0,
  total int NOT NULL DEFAULT 0,
  score double precision,
  inconclusive boolean NOT NULL DEFAULT false,
  results jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS verify_reports_host_idx ON verify_reports (host, ts DESC);

-- Upstream health: failure timestamps (24h window) + latency EMA.
CREATE TABLE IF NOT EXISTS host_fails (
  host text NOT NULL,
  ts bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS host_fails_host_idx ON host_fails (host, ts DESC);
-- Signed operating settings; registration and stake remain onchain.
CREATE TABLE IF NOT EXISTS host_runtime (
  address text PRIMARY KEY,
  revision integer NOT NULL,
  settings jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS host_latency (
  host text PRIMARY KEY,
  ema_ms double precision NOT NULL
);

-- Org rules mirror (synced from web team management).
CREATE TABLE IF NOT EXISTS org_rules (
  org_id text PRIMARY KEY,
  daily_cap double precision,
  allowed_models jsonb,
  allowed_regions jsonb,
  require_verified boolean NOT NULL DEFAULT false,
  rate_limit_per_min int,
  pinned_hosts jsonb,
  handles jsonb NOT NULL DEFAULT '[]'
);
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS allowed_regions jsonb;
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS require_verified boolean NOT NULL DEFAULT false;
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS rate_limit_per_min int;
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS pinned_hosts jsonb;

-- PENDING_TAP queue (L4 device-gated actions).
CREATE TABLE IF NOT EXISTS taps (
  id text PRIMARY KEY,
  kind text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  action_hash text NOT NULL,
  approve_memo text NOT NULL,
  approve_amount_tinybar bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at bigint NOT NULL,
  tap_tx text,
  tap_signer text,
  exec_tx text,
  exec_error text
);
