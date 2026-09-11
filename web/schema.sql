-- Web schema. Applied at boot with CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS schema_version (v int PRIMARY KEY, applied_at timestamptz DEFAULT now());
INSERT INTO schema_version (v) VALUES (1) ON CONFLICT DO NOTHING;

-- Team orgs (spend management; Privy orgs stay in Privy).
CREATE TABLE IF NOT EXISTS team_orgs (
  id text PRIMARY KEY,
  default_allowance_credits double precision,
  period_days int NOT NULL DEFAULT 30,
  creator_wallet text
);
-- Databases created while this column was declared unquoted as periodDays have it as perioddays.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('team_orgs') AND attname = 'perioddays' AND NOT attisdropped)
     AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('team_orgs') AND attname = 'period_days' AND NOT attisdropped) THEN
    ALTER TABLE team_orgs RENAME COLUMN perioddays TO period_days;
  END IF;
EXCEPTION WHEN undefined_column OR duplicate_column THEN
  NULL; -- a concurrent boot renamed it first
END $$;
ALTER TABLE team_orgs ADD COLUMN IF NOT EXISTS creator_wallet text;

-- Team members (allowance null = inherit org default).
CREATE TABLE IF NOT EXISTS team_members (
  org_id text NOT NULL REFERENCES team_orgs (id) ON DELETE CASCADE,
  did text NOT NULL,
  email text,
  wallet_address text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  allowance_credits double precision,
  default_at_add double precision,
  key_prefix text,
  period_start bigint NOT NULL DEFAULT 0,
  added_at bigint NOT NULL,
  PRIMARY KEY (org_id, did)
);

-- Allowance increase requests + wallet-signature audit trail.
CREATE TABLE IF NOT EXISTS increase_requests (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  member_did text NOT NULL,
  amount_credits double precision NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at bigint NOT NULL,
  decided_at bigint,
  decided_by_did text,
  decision_signature text,
  decision_signer text,
  decision_message text,
  decision_expires bigint
);
CREATE INDEX IF NOT EXISTS increase_requests_org_idx ON increase_requests (org_id, created_at DESC);

-- Server-held quorum private keys (team intent auto-approval).
CREATE TABLE IF NOT EXISTS quorum_keys (
  quorum_id text PRIMARY KEY,
  private_key text NOT NULL,
  created_at bigint NOT NULL
);

-- Org rules: firm-level spend policy. daily_cap_credits + allowed_models (null =
-- unlimited/all) + per_tx_cap_usd (display mirror of the Privy policy).
-- Changed ONLY via signed rule-change intents below (owner proposes+decides,
-- managers may propose). Gateway gets a synced copy for pre-flight enforcement.
CREATE TABLE IF NOT EXISTS org_rules (
  org_id text PRIMARY KEY,
  daily_cap_credits double precision,
  allowed_models jsonb,
  allowed_regions jsonb,
  require_verified boolean,
  rate_limit_per_min int,
  pinned_hosts jsonb,
  per_tx_cap_usd double precision,
  updated_at bigint NOT NULL
);
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS allowed_regions jsonb;
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS require_verified boolean;
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS rate_limit_per_min int;
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS pinned_hosts jsonb;

-- Rule-change intents: propose (owner/manager-signed) -> decide (owner-signed)
-- -> applied + synced to gateway. Same audit-trail shape as increase requests.
CREATE TABLE IF NOT EXISTS rule_changes (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  created_at bigint NOT NULL,
  created_by_did text NOT NULL DEFAULT '',
  decided_at bigint,
  decided_by_did text,
  decision text,
  decision_signature text,
  decision_signer text,
  decision_message text,
  decision_expires bigint
);
CREATE INDEX IF NOT EXISTS rule_changes_org_idx ON rule_changes (org_id, created_at DESC);

-- User profiles (display name for UI only — receipts stay hash-anonymous by
-- privacy design; no public attribution without a protocol change).
CREATE TABLE IF NOT EXISTS user_profiles (
  wallet text PRIMARY KEY,
  display_name text NOT NULL DEFAULT '',
  updated_at bigint NOT NULL
);

-- Chat threads (logged-in users, keyed by wallet address — client-claimed identity,
-- own-history only, never authorization). Logged-out users keep localStorage threads.
CREATE TABLE IF NOT EXISTS chat_threads (
  user_handle text NOT NULL,
  thread_id text NOT NULL,
  title text NOT NULL DEFAULT 'New chat',
  updated_at bigint NOT NULL,
  PRIMARY KEY (user_handle, thread_id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  user_handle text NOT NULL,
  thread_id text NOT NULL,
  idx int NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  receipt text,
  settled boolean,
  ts bigint NOT NULL,
  PRIMARY KEY (user_handle, thread_id, idx)
);
