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
