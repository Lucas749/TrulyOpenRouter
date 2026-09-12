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
-- The Privy login that issued the key; null for keys issued before logins were required.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS owner_user_id text;

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
  kind text NOT NULL CHECK (kind IN ('buy_credits', 'refund', 'payout_hbar', 'payout_usdc', 'update_policy')),
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
-- Org-wide switch: may an agent ask a human for more credits at its ceiling? Null/true = yes.
ALTER TABLE org_rules ADD COLUMN IF NOT EXISTS agent_exceptions boolean;
ALTER TABLE team_finance ADD COLUMN IF NOT EXISTS payout_recipients jsonb NOT NULL DEFAULT '[]';
-- Wallet limits each team sets for itself, mirrored in its Privy policy (null = network defaults).
ALTER TABLE team_finance ADD COLUMN IF NOT EXISTS plan_ids jsonb;
ALTER TABLE team_finance ADD COLUMN IF NOT EXISTS payout_cap_hbar_wei text;
ALTER TABLE team_finance ADD COLUMN IF NOT EXISTS payout_cap_usdc_units text;
-- High-stakes payouts: the Ledger that must approve a payout at or above the threshold.
-- No address = no device gate; no threshold with an address = every payout needs the device.
ALTER TABLE team_finance ADD COLUMN IF NOT EXISTS ledger_address text;
ALTER TABLE team_finance ADD COLUMN IF NOT EXISTS ledger_revision integer NOT NULL DEFAULT 0;
ALTER TABLE team_finance ADD COLUMN IF NOT EXISTS payout_ledger_threshold_wei text;
ALTER TABLE treasury_intents ADD COLUMN IF NOT EXISTS policy_change jsonb;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treasury_intents_kind_check' AND pg_get_constraintdef(oid) NOT LIKE '%update_policy%') THEN
    ALTER TABLE treasury_intents DROP CONSTRAINT IF EXISTS treasury_intents_kind_check;
    ALTER TABLE treasury_intents ADD CONSTRAINT treasury_intents_kind_check
      CHECK (kind IN ('buy_credits', 'refund', 'payout_hbar', 'payout_usdc', 'update_policy'));
  END IF;
END $$;

-- Durable usage accounting for strict caps. A request reserves its maximum cost
-- on every accounting subject before any host is paid; settlement moves the
-- actual cost to spent. Unresolved payments keep their reservation until
-- reconciled. Edits and key rotation never reset these counters.
CREATE TABLE IF NOT EXISTS usage_counters (
  subject text NOT NULL,
  period text NOT NULL,
  spent bigint NOT NULL DEFAULT 0,
  reserved bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, period)
);
CREATE TABLE IF NOT EXISTS usage_reservations (
  request_id text PRIMARY KEY,
  payer text NOT NULL,
  agent_id text,
  org_id text,
  member_did text,
  counters jsonb NOT NULL,
  maximum_credits bigint NOT NULL,
  actual_credits bigint,
  approval_id text,
  state text NOT NULL CHECK (state IN ('reserved', 'consumed', 'uncertain', 'released')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_reservations_agent_idx ON usage_reservations (agent_id, state);

-- Agents: stable identity (payer, counters, history) behind rotating credentials.
CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL,
  org_id text REFERENCES team_finance (org_id),
  sponsor_did text,
  payer_kind text NOT NULL CHECK (payer_kind IN ('team', 'personal')),
  budget_label text UNIQUE,
  state text NOT NULL CHECK (state IN ('ready', 'paused', 'revoked')),
  policy jsonb NOT NULL,
  policy_revision integer NOT NULL DEFAULT 1,
  ledger_address text,
  ledger_revision integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner_user_id);
CREATE INDEX IF NOT EXISTS agents_org_idx ON agents (org_id);
-- Only salted hashes are stored; the prefix is a lookup handle, not an identity.
CREATE TABLE IF NOT EXISTS agent_credentials (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  prefix text NOT NULL UNIQUE,
  salt text NOT NULL,
  key_hash text NOT NULL,
  issued_at bigint NOT NULL,
  expires_at bigint,
  revoked_at bigint
);

-- Human approvals for over-limit agent requests. One open approval per request
-- and policy revision; a decision is single-use authority for that request.
CREATE TABLE IF NOT EXISTS agent_approvals (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  org_id text,
  member_did text,
  methods jsonb NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text,
  model text NOT NULL,
  maximum_request_credits bigint NOT NULL,
  additional_credits bigint NOT NULL,
  limits jsonb NOT NULL,
  policy_revision integer NOT NULL,
  membership_revision integer NOT NULL,
  ledger_revision integer NOT NULL,
  nonce text NOT NULL,
  expires_at bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired', 'cancelled', 'reserved', 'consumed', 'uncertain')),
  decided_at bigint,
  grant_expires_at bigint,
  reserved_request_id text,
  created_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_approvals_open_idx ON agent_approvals (agent_id, request_hash, policy_revision)
  WHERE state IN ('pending', 'approved', 'reserved');
CREATE INDEX IF NOT EXISTS agent_approvals_org_idx ON agent_approvals (org_id, created_at DESC);
CREATE TABLE IF NOT EXISTS approval_evidence (
  approval_id text PRIMARY KEY REFERENCES agent_approvals (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('org_owner', 'ledger')),
  message text NOT NULL,
  signature text NOT NULL,
  signer text NOT NULL,
  actor_user_id text NOT NULL,
  actor_role text,
  verified_at bigint NOT NULL
);

-- Personal agent budget funding. Each leg's signed bytes are stored before
-- broadcast; retries resume the same operation and never repeat a leg.
CREATE TABLE IF NOT EXISTS agent_funding_ops (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('buy_credits', 'return_funds')),
  state text NOT NULL CHECK (state IN ('signed', 'submitted', 'confirmed', 'reverted', 'uncertain', 'failed')),
  legs jsonb NOT NULL DEFAULT '[]',
  terms jsonb NOT NULL DEFAULT '{}',
  error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_funding_ops_open_idx ON agent_funding_ops (agent_id) WHERE state IN ('signed', 'submitted', 'uncertain');

-- Team host links: a host key signature binds a registered host to one team wallet.
CREATE TABLE IF NOT EXISTS team_host_links (
  code text PRIMARY KEY,
  org_id text NOT NULL,
  team_name text NOT NULL,
  destination text NOT NULL,
  host_address text,
  registry text,
  state text NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  signature text,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  linked_at bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS team_host_links_active_idx ON team_host_links (host_address) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS team_host_links_org_idx ON team_host_links (org_id);

-- Host earnings collections, recorded leg by leg after on-chain verification.
CREATE TABLE IF NOT EXISTS host_collections (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  host_address text NOT NULL,
  asset text NOT NULL CHECK (asset IN ('hbar', 'usdc')),
  state text NOT NULL CHECK (state IN ('pending', 'received')),
  withdraw_tx text,
  withdrawn_tinybar text,
  transfer_tx text,
  received_amount text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS host_collections_withdraw_idx ON host_collections (withdraw_tx) WHERE withdraw_tx IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS host_collections_transfer_idx ON host_collections (transfer_tx) WHERE transfer_tx IS NOT NULL;
CREATE INDEX IF NOT EXISTS host_collections_org_idx ON host_collections (org_id);
