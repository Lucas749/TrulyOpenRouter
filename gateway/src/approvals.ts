import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { recoverMessageAddress, type Hex } from "viem";
import { db } from "./db.js";
import type { Agent, PgAgents } from "./agents.js";
import type { Identity, PgTeams } from "./teams.js";

// Human approval for an over-limit agent request. The gateway detects the limit
// before any host is paid and records one bounded request: the exact extra
// credits per limit, the request identity, and the policy, membership, and
// Ledger enrollment revisions it was computed against. A same-organization
// owner (linked wallet signature) or an enrolled Ledger signs a server-built
// message; the first valid decision wins and becomes single-use authority for
// that request within a short grant window.

export type ApprovalMethod = "org_owner" | "ledger";
export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "cancelled" | "reserved" | "consumed" | "uncertain";

export interface ApprovalLimit {
  subject: string;
  period: string;
  label: string;
  limit: number;
  extra: number; // additional credits authorized on this counter
}

export interface AgentApproval {
  id: string;
  agentId: string;
  orgId: string | null;
  memberDid: string | null;
  methods: ApprovalMethod[];
  requestHash: string;
  idempotencyKey: string | null;
  model: string;
  maximumRequestCredits: number;
  additionalCredits: number;
  limits: ApprovalLimit[];
  policyRevision: number;
  membershipRevision: number;
  ledgerRevision: number;
  nonce: string;
  expiresAt: number;
  state: ApprovalState;
  decidedAt: number | null;
  grantExpiresAt: number | null;
  reservedRequestId: string | null;
  createdAt: number;
}

export class ApprovalError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
  }
}

export const APPROVAL_WINDOW_MS = 30 * 60_000;
export const GRANT_TTL_MS = 5 * 60_000;
export const MAX_PENDING_PER_AGENT = 5;

const OPEN: ApprovalState[] = ["pending", "approved", "reserved"];
const stripDid = (id: string | null | undefined) => String(id ?? "").replace(/^did:privy:/, "");
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

function rowToApproval(r: any): AgentApproval {
  return {
    id: r.id,
    agentId: r.agent_id,
    orgId: r.org_id ?? null,
    memberDid: r.member_did ?? null,
    methods: json(r.methods),
    requestHash: r.request_hash,
    idempotencyKey: r.idempotency_key ?? null,
    model: r.model,
    maximumRequestCredits: Number(r.maximum_request_credits),
    additionalCredits: Number(r.additional_credits),
    limits: json(r.limits),
    policyRevision: Number(r.policy_revision),
    membershipRevision: Number(r.membership_revision),
    ledgerRevision: Number(r.ledger_revision),
    nonce: r.nonce,
    expiresAt: Number(r.expires_at),
    state: r.state,
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    grantExpiresAt: r.grant_expires_at == null ? null : Number(r.grant_expires_at),
    reservedRequestId: r.reserved_request_id ?? null,
    createdAt: Number(r.created_at),
  };
}

/// @notice The exact message a human signs. Rebuilt from stored records at verification time.
export function approvalMessage(a: AgentApproval, context: { origin: string; agentName: string }): string {
  return [
    "TrulyOpenRouter spending approval",
    `origin: ${context.origin}`,
    "network: hedera-testnet",
    `approval: ${a.id}`,
    `agent: ${a.agentId} (${context.agentName})`,
    `payer: ${a.orgId ? `team ${a.orgId}` : "personal budget"}`,
    ...(a.memberDid ? [`member: ${a.memberDid}`] : []),
    `model: ${a.model}`,
    `request: ${a.requestHash}`,
    `request maximum: ${a.maximumRequestCredits} credits`,
    `additional: ${a.additionalCredits} credits`,
    ...a.limits.map((l) => `limit: ${l.label} ${l.limit} +${l.extra}`),
    `grant: this request once, within ${GRANT_TTL_MS / 60_000} minutes`,
    `revisions: policy ${a.policyRevision}, membership ${a.membershipRevision}, ledger ${a.ledgerRevision}`,
    `nonce: ${a.nonce}`,
    `expires: ${a.expiresAt}`,
  ].join("\n");
}

export class PgApprovals {
  constructor(private pool: Pick<Pool, "query" | "connect"> = db()) {}

  async get(id: string): Promise<AgentApproval | null> {
    const { rows } = await this.pool.query(`SELECT * FROM agent_approvals WHERE id = $1`, [id]);
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  async list(filter: { orgId?: string; agentIds?: string[] }, limit = 50): Promise<AgentApproval[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_approvals WHERE ($1::text IS NULL OR org_id = $1) AND ($2::text[] IS NULL OR agent_id = ANY($2::text[]))
       ORDER BY created_at DESC LIMIT $3`,
      [filter.orgId ?? null, filter.agentIds ?? null, limit],
    );
    return rows.map(rowToApproval);
  }

  /// @notice Create the approval for this exact request and policy revision, or return the open one.
  async requestFor(
    input: Omit<AgentApproval, "id" | "nonce" | "state" | "decidedAt" | "grantExpiresAt" | "reservedRequestId" | "createdAt" | "expiresAt">,
    now = Date.now(),
  ): Promise<{ approval: AgentApproval; created: boolean }> {
    const open = await this.pool.query(
      `SELECT * FROM agent_approvals WHERE agent_id = $1 AND request_hash = $2 AND policy_revision = $3 AND state = ANY($4::text[])`,
      [input.agentId, input.requestHash, input.policyRevision, OPEN],
    );
    if (open.rows[0]) return { approval: rowToApproval(open.rows[0]), created: false };
    const pending = await this.pool.query(`SELECT count(*)::int AS n FROM agent_approvals WHERE agent_id = $1 AND state = 'pending' AND expires_at > $2`, [input.agentId, now]);
    if (Number(pending.rows[0].n) >= MAX_PENDING_PER_AGENT) {
      throw new ApprovalError(429, "approval_queue_full", "This agent already has too many pending approvals. Wait for a decision before retrying.");
    }
    const { rows } = await this.pool.query(
      `INSERT INTO agent_approvals (id, agent_id, org_id, member_did, methods, request_hash, idempotency_key, model, maximum_request_credits,
         additional_credits, limits, policy_revision, membership_revision, ledger_revision, nonce, expires_at, state, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17)
       ON CONFLICT DO NOTHING RETURNING *`,
      [`apr_${randomUUID().replace(/-/g, "").slice(0, 24)}`, input.agentId, input.orgId, input.memberDid, JSON.stringify(input.methods), input.requestHash,
        input.idempotencyKey, input.model, input.maximumRequestCredits, input.additionalCredits, JSON.stringify(input.limits), input.policyRevision,
        input.membershipRevision, input.ledgerRevision, randomBytes(16).toString("hex"), now + APPROVAL_WINDOW_MS, now],
    );
    if (rows[0]) return { approval: rowToApproval(rows[0]), created: true };
    // A concurrent copy of the same request created it first.
    const again = await this.pool.query(
      `SELECT * FROM agent_approvals WHERE agent_id = $1 AND request_hash = $2 AND policy_revision = $3 AND state = ANY($4::text[])`,
      [input.agentId, input.requestHash, input.policyRevision, OPEN],
    );
    if (!again.rows[0]) throw new ApprovalError(409, "approval_conflict", "The approval changed. Retry the request.");
    return { approval: rowToApproval(again.rows[0]), created: false };
  }

  /// @notice Record one decision atomically. Returns null when it is no longer pending or has expired.
  async approve(
    id: string,
    evidence: { method: ApprovalMethod; message: string; signature: string; signer: string; actorUserId: string; actorRole: string | null },
    now = Date.now(),
  ): Promise<AgentApproval | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE agent_approvals SET state = 'approved', decided_at = $2, grant_expires_at = $3
         WHERE id = $1 AND state = 'pending' AND expires_at > $2 RETURNING *`,
        [id, now, now + GRANT_TTL_MS],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `INSERT INTO approval_evidence (approval_id, method, message, signature, signer, actor_user_id, actor_role, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, evidence.method, evidence.message, evidence.signature, evidence.signer.toLowerCase(), evidence.actorUserId, evidence.actorRole, now],
      );
      await client.query("COMMIT");
      return rowToApproval(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async evidence(id: string): Promise<{ method: ApprovalMethod; signer: string; actorUserId: string; actorRole: string | null; verifiedAt: number } | null> {
    const { rows } = await this.pool.query(`SELECT * FROM approval_evidence WHERE approval_id = $1`, [id]);
    const r = rows[0];
    return r ? { method: r.method, signer: r.signer, actorUserId: r.actor_user_id, actorRole: r.actor_role ?? null, verifiedAt: Number(r.verified_at) } : null;
  }

  async setState(id: string, from: ApprovalState[], to: ApprovalState): Promise<AgentApproval | null> {
    const { rows } = await this.pool.query(`UPDATE agent_approvals SET state = $2 WHERE id = $1 AND state = ANY($3::text[]) RETURNING *`, [id, to, from]);
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  /// @notice Policy changes, revocation, or a changed payer void pending approvals and unused grants.
  async cancelOpen(filter: { agentId?: string; orgId?: string; memberDid?: string }): Promise<number> {
    const result = await this.pool.query(
      `UPDATE agent_approvals SET state = 'cancelled'
       WHERE state IN ('pending', 'approved') AND ($1::text IS NULL OR agent_id = $1) AND ($2::text IS NULL OR org_id = $2) AND ($3::text IS NULL OR member_did = $3)`,
      [filter.agentId ?? null, filter.orgId ?? null, filter.memberDid ?? null],
    );
    return result.rowCount ?? 0;
  }

  /// @notice Reserve an approved, unexpired grant for exactly this request. At most one caller wins.
  async claimGrant(agentId: string, requestHash: string, policyRevision: number, requestId: string, now = Date.now()): Promise<AgentApproval | null> {
    const { rows } = await this.pool.query(
      `UPDATE agent_approvals SET state = 'reserved', reserved_request_id = $4
       WHERE id = (SELECT id FROM agent_approvals WHERE agent_id = $1 AND request_hash = $2 AND policy_revision = $3 AND state = 'approved' AND grant_expires_at > $5 LIMIT 1)
         AND state = 'approved' RETURNING *`,
      [agentId, requestHash, policyRevision, requestId, now],
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  /// @notice Finish a reserved grant: consumed on settlement, uncertain on unknown payment, or back to approved when proven unpaid.
  async finishGrant(id: string, requestId: string, to: "consumed" | "uncertain" | "approved"): Promise<AgentApproval | null> {
    const { rows } = await this.pool.query(
      `UPDATE agent_approvals SET state = $3, reserved_request_id = CASE WHEN $3 = 'approved' THEN NULL ELSE reserved_request_id END
       WHERE id = $1 AND state = 'reserved' AND reserved_request_id = $2 RETURNING *`,
      [id, requestId, to],
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }
}

export interface DecisionDeps {
  approvals: PgApprovals;
  agents: Pick<PgAgents, "get">;
  teams: Pick<PgTeams, "team" | "memberFor">;
  origin: string;
  now?: () => number;
}

/// @notice The permitted human decision on an approval. Owner route: an active owner of the
/// agent's organization, signing with a wallet linked to the login. Ledger route: the enrolled
/// Ledger address, while the team owner (team agent) or agent owner (personal) is signed in.
export async function decideAgentApproval(
  d: DecisionDeps,
  approvalId: string,
  actor: { identity: Identity },
  input: { decision: "approve" | "deny"; method: ApprovalMethod; signature?: string },
): Promise<AgentApproval> {
  const now = (d.now ?? Date.now)();
  const approval = await d.approvals.get(approvalId);
  if (!approval) throw new ApprovalError(404, "not_found", "Approval not found.");
  const agent = await d.agents.get(approval.agentId);
  if (!agent) throw new ApprovalError(404, "not_found", "Approval not found.");
  const authority = await approvalAuthority(d, agent, actor.identity);
  if (!authority.canView) throw new ApprovalError(404, "not_found", "Approval not found.");
  if (approval.state !== "pending") throw new ApprovalError(409, "already_decided", `This approval is ${approval.state}.`);
  if (now >= approval.expiresAt) {
    await d.approvals.setState(approval.id, ["pending"], "expired");
    throw new ApprovalError(409, "expired", "This approval window has ended. The agent can retry to request a new one.");
  }
  if (!approval.methods.includes(input.method)) throw new ApprovalError(403, "method_not_permitted", "That approval method is not permitted for this request.");
  if (input.method === "org_owner" && !authority.orgOwner) {
    throw new ApprovalError(403, "forbidden", "Only an active owner of this organization can approve its spending increases.");
  }
  if (input.method === "ledger" && !authority.ledgerHuman) {
    throw new ApprovalError(403, "forbidden", "Sign in as the account responsible for this agent to use its Ledger.");
  }
  if (agent.state !== "ready" || agent.policyRevision !== approval.policyRevision || agent.ledgerRevision !== approval.ledgerRevision ||
      (agent.orgId && (!authority.sponsorActive || authority.membershipRevision !== approval.membershipRevision))) {
    await d.approvals.setState(approval.id, ["pending"], "cancelled");
    throw new ApprovalError(409, "stale_approval", "The agent's policy, team membership, or Ledger enrollment changed. The agent can retry to request a new approval.");
  }
  if (input.decision === "deny") {
    const denied = await d.approvals.setState(approval.id, ["pending"], "denied");
    if (!denied) throw new ApprovalError(409, "already_decided", "This approval was already decided.");
    return denied;
  }
  if (!input.signature || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new ApprovalError(400, "invalid_request", "A signature over the approval message is required.");
  const message = approvalMessage(approval, { origin: d.origin, agentName: agent.name });
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message, signature: input.signature as Hex })).toLowerCase();
  } catch {
    throw new ApprovalError(401, "bad_signature", "The approval signature is invalid.");
  }
  if (input.method === "org_owner" && !actor.identity.wallets.some((w) => w.toLowerCase() === signer)) {
    throw new ApprovalError(401, "bad_signature", "Sign the approval with a wallet linked to your login.");
  }
  if (input.method === "ledger" && signer !== agent.ledgerAddress?.toLowerCase()) {
    throw new ApprovalError(401, "bad_signature", "The signature is not from this agent's enrolled Ledger.");
  }
  const approved = await d.approvals.approve(
    approval.id,
    { method: input.method, message, signature: input.signature, signer, actorUserId: actor.identity.userId, actorRole: authority.role },
    now,
  );
  if (!approved) throw new ApprovalError(409, "already_decided", "This approval was already decided.");
  return approved;
}

/// @notice Approve from a terminal with the agent's enrolled Ledger. The device signs the exact approval
/// message over USB (Ledger's Device Management Kit), so the agent may relay the signature: only the
/// enrolled Ledger can produce it, and it binds this approval's terms, nonce, and expiry.
export async function approveByLedgerSignature(d: DecisionDeps, approvalId: string, agentId: string, signature: unknown): Promise<AgentApproval> {
  const now = (d.now ?? Date.now)();
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new ApprovalError(400, "invalid_request", "A signature over the approval message is required.");
  }
  const approval = await d.approvals.get(approvalId);
  const agent = approval?.agentId === agentId ? await d.agents.get(agentId) : null;
  if (!approval || !agent) throw new ApprovalError(404, "not_found", "Approval not found.");
  if (approval.state !== "pending") throw new ApprovalError(409, "already_decided", `This approval is ${approval.state}.`);
  if (now >= approval.expiresAt) {
    await d.approvals.setState(approval.id, ["pending"], "expired");
    throw new ApprovalError(409, "expired", "This approval window has ended. The agent can retry to request a new one.");
  }
  if (!approval.methods.includes("ledger") || !agent.ledgerAddress) {
    throw new ApprovalError(403, "method_not_permitted", "This request cannot be approved with the agent's Ledger.");
  }
  const authority = await approvalAuthority(d, agent, { userId: agent.ownerUserId, wallets: [] });
  if (agent.state !== "ready" || agent.policyRevision !== approval.policyRevision || agent.ledgerRevision !== approval.ledgerRevision ||
      (agent.orgId && (!authority.sponsorActive || authority.membershipRevision !== approval.membershipRevision))) {
    await d.approvals.setState(approval.id, ["pending"], "cancelled");
    throw new ApprovalError(409, "stale_approval", "The agent's policy, team membership, or Ledger enrollment changed. The agent can retry to request a new approval.");
  }
  const message = approvalMessage(approval, { origin: d.origin, agentName: agent.name });
  let signer: string;
  try {
    signer = (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase();
  } catch {
    throw new ApprovalError(401, "bad_signature", "The approval signature is invalid.");
  }
  if (signer !== agent.ledgerAddress.toLowerCase()) throw new ApprovalError(401, "bad_signature", "The signature is not from this agent's enrolled Ledger.");
  const approved = await d.approvals.approve(
    approval.id,
    { method: "ledger", message, signature, signer, actorUserId: agent.ownerUserId, actorRole: "enrolled_ledger" },
    now,
  );
  if (!approved) throw new ApprovalError(409, "already_decided", "This approval was already decided.");
  return approved;
}

/// @notice Who may see and decide approvals for an agent.
export async function approvalAuthority(d: Pick<DecisionDeps, "teams">, agent: Agent, identity: Identity) {
  if (!agent.orgId) {
    const owner = stripDid(agent.ownerUserId) === stripDid(identity.userId);
    return { canView: owner, orgOwner: false, ledgerHuman: owner && !!agent.ledgerAddress, sponsorActive: true, membershipRevision: 0, role: owner ? "agent_owner" : null };
  }
  const [member, team, sponsor] = await Promise.all([
    d.teams.memberFor(agent.orgId, identity),
    d.teams.team(agent.orgId),
    agent.sponsorDid ? d.teams.memberFor(agent.orgId, { userId: agent.sponsorDid, wallets: [] }) : Promise.resolve(null),
  ]);
  const orgOwner = member?.role === "owner";
  const agentOwner = stripDid(agent.ownerUserId) === stripDid(identity.userId) && !!member;
  return {
    canView: orgOwner || agentOwner,
    orgOwner,
    ledgerHuman: orgOwner && !!agent.ledgerAddress,
    sponsorActive: !!sponsor,
    membershipRevision: team?.membershipRevision ?? 0,
    role: member?.role ?? null,
  };
}
