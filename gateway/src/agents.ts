import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { db } from "./db.js";

// Agents: a stable identity (payer, counters, history) behind rotating
// tor_sk_agt_ credentials. Only a salted hash of each credential is stored; the
// display prefix is a lookup handle, never an ownership or accounting identity.

export type AgentState = "ready" | "paused" | "revoked";
export type PayerKind = "team" | "personal";

export interface AgentPolicy {
  dailyCredits: number | null; // UTC day
  monthlyCredits: number | null; // UTC calendar month
  lifetimeCredits: number | null;
  maxRequestCredits: number | null;
  models: string[] | null; // null = whatever the parent allows
  regions: string[] | null;
  verifiedOnly: boolean;
  requestsPerMinute: number | null;
  maxConcurrent: number | null;
  credentialTtlDays: number | null;
  exceptions: { credits: boolean }; // whether credit limits may request an exception
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  ownerUserId: string;
  orgId: string | null;
  sponsorDid: string | null;
  payerKind: PayerKind;
  budgetLabel: string | null; // personal agents: immutable budget account derivation label
  state: AgentState;
  policy: AgentPolicy;
  policyRevision: number;
  ledgerAddress: string | null;
  ledgerRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentCredential {
  id: string;
  agentId: string;
  prefix: string;
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export class AgentError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
  }
}

export const AGENT_KEY_PREFIX = "tor_sk_agt_";

function credits(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new AgentError(400, "invalid_request", `${label} must be a whole non-negative number of credits or empty`);
  return n;
}

function bounded(value: unknown, label: string, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new AgentError(400, "invalid_request", `${label} must be between 1 and ${max} or empty`);
  return n;
}

function list(value: unknown, label: string, pattern: RegExp): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > 50 || !value.every((v) => typeof v === "string" && pattern.test(v))) {
    throw new AgentError(400, "invalid_request", `${label} must be a list of valid values or empty`);
  }
  return [...new Set(value as string[])];
}

/// @notice Validate an agent policy. Unset limits are unlimited within parent rules.
export function normalizePolicy(input: unknown): AgentPolicy {
  const p = (input ?? {}) as Record<string, any>;
  return {
    dailyCredits: credits(p.dailyCredits, "Daily credits"),
    monthlyCredits: credits(p.monthlyCredits, "Monthly credits"),
    lifetimeCredits: credits(p.lifetimeCredits, "Lifetime credits"),
    maxRequestCredits: credits(p.maxRequestCredits, "Maximum credits per request"),
    models: list(p.models, "Models", /^[\w.:/-]{1,80}$/),
    regions: list(p.regions, "Regions", /^[a-z]{2}-[a-z0-9-]{2,29}$/),
    verifiedOnly: p.verifiedOnly === true,
    requestsPerMinute: bounded(p.requestsPerMinute, "Requests per minute", 10_000),
    maxConcurrent: bounded(p.maxConcurrent, "Concurrent requests", 100),
    credentialTtlDays: bounded(p.credentialTtlDays, "Credential expiry", 365),
    exceptions: { credits: p.exceptions?.credits !== false },
  };
}

function hashSecret(key: string, salt: string): string {
  return createHash("sha256").update(salt).update(key).digest("hex");
}

function newSecret(): { key: string; prefix: string; salt: string; hash: string } {
  const key = `${AGENT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const salt = randomBytes(16).toString("hex");
  return { key, prefix: key.slice(0, AGENT_KEY_PREFIX.length + 10), salt, hash: hashSecret(key, salt) };
}

const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

function rowToAgent(r: any): Agent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ownerUserId: r.owner_user_id,
    orgId: r.org_id ?? null,
    sponsorDid: r.sponsor_did ?? null,
    payerKind: r.payer_kind,
    budgetLabel: r.budget_label ?? null,
    state: r.state,
    policy: normalizePolicy(json(r.policy)),
    policyRevision: Number(r.policy_revision),
    ledgerAddress: r.ledger_address ?? null,
    ledgerRevision: Number(r.ledger_revision),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function rowToCredential(r: any): AgentCredential {
  return {
    id: r.id,
    agentId: r.agent_id,
    prefix: r.prefix,
    issuedAt: Number(r.issued_at),
    expiresAt: r.expires_at == null ? null : Number(r.expires_at),
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at),
  };
}

export class PgAgents {
  constructor(private pool: Pick<Pool, "query" | "connect"> = db()) {}

  private async issue(client: Pick<Pool, "query">, agent: Agent, now: number): Promise<{ key: string; credential: AgentCredential }> {
    const secret = newSecret();
    const ttl = agent.policy.credentialTtlDays;
    const { rows } = await client.query(
      `INSERT INTO agent_credentials (id, agent_id, prefix, salt, key_hash, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [`crd_${randomUUID()}`, agent.id, secret.prefix, secret.salt, secret.hash, now, ttl ? now + ttl * 86_400_000 : null],
    );
    return { key: secret.key, credential: rowToCredential(rows[0]) };
  }

  /// @notice Create an agent with its first credential. The secret is returned once.
  async create(input: { name: string; description?: string; ownerUserId: string; orgId: string | null; sponsorDid: string | null; policy: AgentPolicy }): Promise<{ agent: Agent; key: string; credential: AgentCredential }> {
    const name = input.name.trim();
    if (!name || name.length > 64) throw new AgentError(400, "invalid_request", "Agent name is required (64 characters or fewer).");
    if ((input.orgId === null) !== (input.sponsorDid === null)) throw new AgentError(400, "invalid_request", "Team agents need both a team and a sponsoring member.");
    const id = `agt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const payerKind: PayerKind = input.orgId ? "team" : "personal";
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO agents (id, name, description, owner_user_id, org_id, sponsor_did, payer_kind, budget_label, state, policy, policy_revision, ledger_revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready', $9, 1, 0, $10, $10) RETURNING *`,
        [id, name, (input.description ?? "").slice(0, 280), input.ownerUserId, input.orgId, input.sponsorDid, payerKind,
          payerKind === "personal" ? `agent:${id}` : null, JSON.stringify(input.policy), now],
      );
      const agent = rowToAgent(rows[0]);
      const issued = await this.issue(client, agent, now);
      await client.query("COMMIT");
      return { agent, ...issued };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<Agent | null> {
    const { rows } = await this.pool.query(`SELECT * FROM agents WHERE id = $1`, [id]);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async listForOwner(userId: string): Promise<Agent[]> {
    const { rows } = await this.pool.query(`SELECT * FROM agents WHERE owner_user_id = $1 ORDER BY created_at DESC`, [userId]);
    return rows.map(rowToAgent);
  }

  async listForOrg(orgId: string): Promise<Agent[]> {
    const { rows } = await this.pool.query(`SELECT * FROM agents WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
    return rows.map(rowToAgent);
  }

  async credentials(agentId: string): Promise<AgentCredential[]> {
    const { rows } = await this.pool.query(`SELECT * FROM agent_credentials WHERE agent_id = $1 ORDER BY issued_at DESC`, [agentId]);
    return rows.map(rowToCredential);
  }

  /// @notice Resolve a presented credential. Invalid, expired, and revoked credentials resolve to null.
  async authenticate(key: string, now = Date.now()): Promise<{ agent: Agent; credential: AgentCredential } | null> {
    if (!key.startsWith(AGENT_KEY_PREFIX) || key.length > 128) return null;
    const { rows } = await this.pool.query(`SELECT * FROM agent_credentials WHERE prefix = $1`, [key.slice(0, AGENT_KEY_PREFIX.length + 10)]);
    const row = rows[0];
    if (!row) return null;
    const a = Buffer.from(hashSecret(key, row.salt), "hex");
    const b = Buffer.from(row.key_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const credential = rowToCredential(row);
    if (credential.revokedAt !== null || (credential.expiresAt !== null && now >= credential.expiresAt)) return null;
    const agent = await this.get(credential.agentId);
    return agent ? { agent, credential } : null;
  }

  /// @notice Replace every active credential with a new one. Payer, counters, and history stay with the agent.
  async rotate(agentId: string): Promise<{ key: string; credential: AgentCredential }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT * FROM agents WHERE id = $1 FOR UPDATE`, [agentId]);
      if (!rows[0]) throw new AgentError(404, "not_found", "Agent not found.");
      const agent = rowToAgent(rows[0]);
      if (agent.state === "revoked") throw new AgentError(409, "agent_revoked", "A revoked agent cannot receive new credentials.");
      const now = Date.now();
      await client.query(`UPDATE agent_credentials SET revoked_at = $2 WHERE agent_id = $1 AND revoked_at IS NULL`, [agentId, now]);
      const issued = await this.issue(client, agent, now);
      await client.query("COMMIT");
      return issued;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /// @notice Pause, resume, or revoke. Revocation also revokes all credentials and is final.
  async setState(agentId: string, to: AgentState): Promise<Agent> {
    const from: AgentState[] = to === "ready" ? ["paused"] : to === "paused" ? ["ready"] : ["ready", "paused"];
    const now = Date.now();
    const { rows } = await this.pool.query(
      `UPDATE agents SET state = $2, updated_at = $3 WHERE id = $1 AND state = ANY($4::text[]) RETURNING *`,
      [agentId, to, now, from],
    );
    if (!rows[0]) {
      const current = await this.get(agentId);
      if (!current) throw new AgentError(404, "not_found", "Agent not found.");
      throw new AgentError(409, "invalid_state", `The agent is already ${current.state}.`);
    }
    if (to === "revoked") await this.pool.query(`UPDATE agent_credentials SET revoked_at = $2 WHERE agent_id = $1 AND revoked_at IS NULL`, [agentId, now]);
    return rowToAgent(rows[0]);
  }

  /// @notice Replace the policy at an expected revision. The revision always advances, invalidating pending approvals.
  async updatePolicy(agentId: string, policy: AgentPolicy, expectedRevision: number): Promise<Agent> {
    const { rows } = await this.pool.query(
      `UPDATE agents SET policy = $2, policy_revision = policy_revision + 1, updated_at = $3
       WHERE id = $1 AND policy_revision = $4 AND state <> 'revoked' RETURNING *`,
      [agentId, JSON.stringify(policy), Date.now(), expectedRevision],
    );
    if (!rows[0]) throw new AgentError(409, "revision_conflict", "The agent changed. Refresh and review the policy again.");
    return rowToAgent(rows[0]);
  }
}
