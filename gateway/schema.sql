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

-- Retain unresolved payment attempts across restarts. Reconcile before release.
CREATE TABLE IF NOT EXISTS billing_requests (
  payer text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  created_at bigint NOT NULL,
  submitted boolean NOT NULL DEFAULT false,
  host text,
  maximum_credits text
);

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
-- Dedicated testnet funding. Retain signed bytes so retries cannot pay twice.
CREATE TABLE IF NOT EXISTS host_faucet_grants (
  address text PRIMARY KEY,
  user_id text NOT NULL,
  created_at bigint NOT NULL,
  transaction_id text NOT NULL UNIQUE,
  signed_transaction text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed'))
);
CREATE INDEX IF NOT EXISTS host_faucet_grants_created_idx ON host_faucet_grants (created_at);
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

-- Team finance: organization wallet mapping plus the web membership mirror.
-- The web app owns invites and roles and pushes the full team snapshot after
-- each change. Team payers and approval authority resolve only from these rows.
CREATE TABLE IF NOT EXISTS team_finance (
  org_id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  wallet_id text,
  wallet_address text,
  quorum_id text,
  policy_id text,
  approver_user_id text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'disabled')),
  default_allowance_credits bigint,
  membership_revision integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS team_finance_wallet_idx ON team_finance (wallet_address) WHERE wallet_address IS NOT NULL;
CREATE TABLE IF NOT EXISTS team_finance_members (
  org_id text NOT NULL REFERENCES team_finance (org_id) ON DELETE CASCADE,
  did text NOT NULL,
  wallet text,
  email text,
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'member')),
  status text NOT NULL CHECK (status IN ('active', 'invited', 'removed')),
  allowance_credits bigint,
  PRIMARY KEY (org_id, did)
);
CREATE INDEX IF NOT EXISTS team_finance_members_wallet_idx ON team_finance_members (wallet);

-- Team treasury transactions through Privy intents. Terms are prepared before
-- approval; signed bytes are stored before broadcast so failures reconcile by
-- the same transaction identity instead of signing a replacement.
CREATE TABLE IF NOT EXISTS treasury_intents (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES team_finance (org_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('buy_credits', 'refund', 'payout_hbar', 'payout_usdc')),
  privy_intent_id text UNIQUE,
  wallet_address text NOT NULL,
  transaction jsonb NOT NULL,
  terms jsonb NOT NULL,
  action_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed', 'awaiting_approvals', 'authorized', 'signed', 'submitted', 'confirmed',
    'denied', 'expired', 'reverted', 'cancelled', 'uncertain', 'failed')),
  proposed_by text NOT NULL,
  approvals jsonb NOT NULL DEFAULT '[]',
  signed_transaction text,
  transaction_hash text,
  result jsonb NOT NULL DEFAULT '{}',
  error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS treasury_intents_org_idx ON treasury_intents (org_id, created_at DESC);
-- At most one unfinished treasury transaction per team keeps nonces unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS treasury_intents_open_idx ON treasury_intents (org_id)
  WHERE state IN ('proposed', 'awaiting_approvals', 'authorized', 'signed', 'submitted', 'uncertain');
ALTER TABLE team_finance ADD COLUMN IF NOT EXISTS payout_recipients jsonb NOT NULL DEFAULT '[]';
