import type { Pool } from "pg";
import { db } from "./db.js";

// Team finance membership mirror. Invites, roles, and allowances are managed in
// the web app, which pushes the full team snapshot after every signed change
// (admin token). Team payers and approval authority resolve only from these
// rows and the verified login, never from request bodies.

export type TeamRole = "owner" | "manager" | "member";
export type TeamMemberStatus = "active" | "invited" | "removed";

export interface TeamMember {
  orgId: string;
  did: string;
  wallet: string | null; // lowercased
  email: string | null;
  role: TeamRole;
  status: TeamMemberStatus;
  allowanceCredits: number | null; // null = team default
}

export interface Team {
  orgId: string;
  name: string;
  walletId: string | null;
  walletAddress: string | null; // lowercased
  quorumId: string | null;
  policyId: string | null;
  approverUserId: string | null;
  state: "pending" | "active" | "disabled";
  defaultAllowanceCredits: number | null;
  membershipRevision: number;
}

export interface TeamSnapshot {
  orgId: string;
  name?: string;
  defaultAllowanceCredits: number | null;
  members: Omit<TeamMember, "orgId">[];
}

/// @notice A verified login: Privy subject plus server-side linked wallets.
export interface Identity {
  userId: string;
  wallets: string[];
}

export class TeamError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function credits(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TeamError(400, `${label} must be a whole non-negative credit amount or null`);
  return n;
}

/// @notice Validate a pushed snapshot before any storage. Wallets are lowercased.
export function normalizeSnapshot(orgId: string, input: unknown): TeamSnapshot {
  const body = (input ?? {}) as Record<string, unknown>;
  if (!orgId || orgId.length > 128) throw new TeamError(400, "orgId required");
  if (!Array.isArray(body.members) || body.members.length > 1000) throw new TeamError(400, "members must be an array");
  const seen = new Set<string>();
  const members = body.members.map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    const did = typeof m.did === "string" ? m.did : "";
    if (!did || did.length > 256) throw new TeamError(400, "member did required");
    if (seen.has(did)) throw new TeamError(400, `duplicate member ${did}`);
    seen.add(did);
    if (m.role !== "owner" && m.role !== "manager" && m.role !== "member") throw new TeamError(400, "member role must be owner|manager|member");
    if (m.status !== "active" && m.status !== "invited" && m.status !== "removed") throw new TeamError(400, "member status must be active|invited|removed");
    const wallet = m.wallet === null || m.wallet === undefined || m.wallet === "" ? null : String(m.wallet);
    if (wallet !== null && !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new TeamError(400, "member wallet must be 0x + 40 hex or null");
    const email = typeof m.email === "string" && m.email ? m.email.toLowerCase() : null;
    return { did, wallet: wallet?.toLowerCase() ?? null, email, role: m.role as TeamRole, status: m.status as TeamMemberStatus, allowanceCredits: credits(m.allowanceCredits, "member allowance") };
  });
  const name = typeof body.name === "string" ? body.name.slice(0, 64) : undefined;
  return { orgId, ...(name === undefined ? {} : { name }), defaultAllowanceCredits: credits(body.defaultAllowanceCredits, "default allowance"), members };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function rowToTeam(r: any): Team {
  return {
    orgId: r.org_id,
    name: r.name,
    walletId: r.wallet_id ?? null,
    walletAddress: r.wallet_address ?? null,
    quorumId: r.quorum_id ?? null,
    policyId: r.policy_id ?? null,
    approverUserId: r.approver_user_id ?? null,
    state: r.state,
    defaultAllowanceCredits: num(r.default_allowance_credits),
    membershipRevision: Number(r.membership_revision),
  };
}

function rowToMember(r: any): TeamMember {
  return {
    orgId: r.org_id,
    did: r.did,
    wallet: r.wallet ?? null,
    email: r.email ?? null,
    role: r.role,
    status: r.status,
    allowanceCredits: num(r.allowance_credits),
  };
}

const sameMember = (a: Omit<TeamMember, "orgId">, b: Omit<TeamMember, "orgId">) =>
  a.wallet === b.wallet && a.email === b.email && a.role === b.role && a.status === b.status && a.allowanceCredits === b.allowanceCredits;

export class PgTeams {
  constructor(private pool: Pick<Pool, "query" | "connect"> = db()) {}

  async team(orgId: string): Promise<Team | null> {
    const { rows } = await this.pool.query(`SELECT * FROM team_finance WHERE org_id = $1`, [orgId]);
    return rows[0] ? rowToTeam(rows[0]) : null;
  }

  async members(orgId: string): Promise<TeamMember[]> {
    const { rows } = await this.pool.query(`SELECT * FROM team_finance_members WHERE org_id = $1 ORDER BY did`, [orgId]);
    return rows.map(rowToMember);
  }

  /// @notice The active membership of this login in one team, by Privy subject first, then linked wallet.
  async memberFor(orgId: string, identity: Identity): Promise<TeamMember | null> {
    const wallets = identity.wallets.map((w) => w.toLowerCase());
    const { rows } = await this.pool.query(
      `SELECT * FROM team_finance_members
       WHERE org_id = $1 AND status = 'active' AND (did = $2 OR wallet = ANY($3::text[]))
       ORDER BY (did = $2) DESC LIMIT 1`,
      [orgId, identity.userId, wallets],
    );
    return rows[0] ? rowToMember(rows[0]) : null;
  }

  async teamsFor(identity: Identity): Promise<Team[]> {
    const wallets = identity.wallets.map((w) => w.toLowerCase());
    const { rows } = await this.pool.query(
      `SELECT DISTINCT t.* FROM team_finance t JOIN team_finance_members m ON m.org_id = t.org_id
       WHERE m.status = 'active' AND (m.did = $1 OR m.wallet = ANY($2::text[])) ORDER BY t.org_id`,
      [identity.userId, wallets],
    );
    return rows.map(rowToTeam);
  }

  /// @notice Replace one team's membership mirror atomically. Rows missing from
  /// the snapshot become removed (history kept). The membership revision only
  /// advances when something changed, so stale approvals can be detected.
  async applySnapshot(snapshot: TeamSnapshot): Promise<{ revision: number; changed: boolean; removed: string[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const now = Date.now();
      await client.query(
        `INSERT INTO team_finance (org_id, name, default_allowance_credits, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4) ON CONFLICT (org_id) DO NOTHING`,
        [snapshot.orgId, snapshot.name ?? "", snapshot.defaultAllowanceCredits, now],
      );
      const team = rowToTeam((await client.query(`SELECT * FROM team_finance WHERE org_id = $1 FOR UPDATE`, [snapshot.orgId])).rows[0]);
      const before = new Map((await client.query(`SELECT * FROM team_finance_members WHERE org_id = $1`, [snapshot.orgId])).rows.map((r) => [r.did, rowToMember(r)]));
      let changed = team.defaultAllowanceCredits !== snapshot.defaultAllowanceCredits || (snapshot.name !== undefined && snapshot.name !== team.name);
      const removed: string[] = [];
      for (const m of snapshot.members) {
        const prior = before.get(m.did);
        if (prior && sameMember(prior, m)) continue;
        changed = true;
        if (prior?.status === "active" && m.status !== "active") removed.push(m.did);
        await client.query(
          `INSERT INTO team_finance_members (org_id, did, wallet, email, role, status, allowance_credits)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (org_id, did) DO UPDATE SET wallet = EXCLUDED.wallet, email = EXCLUDED.email, role = EXCLUDED.role,
             status = EXCLUDED.status, allowance_credits = EXCLUDED.allowance_credits`,
          [snapshot.orgId, m.did, m.wallet, m.email, m.role, m.status, m.allowanceCredits],
        );
      }
      const listed = new Set(snapshot.members.map((m) => m.did));
      for (const prior of before.values()) {
        if (listed.has(prior.did) || prior.status === "removed") continue;
        changed = true;
        if (prior.status === "active") removed.push(prior.did);
        await client.query(`UPDATE team_finance_members SET status = 'removed' WHERE org_id = $1 AND did = $2`, [snapshot.orgId, prior.did]);
      }
      const revision = team.membershipRevision + (changed ? 1 : 0);
      if (changed) {
        await client.query(
          `UPDATE team_finance SET membership_revision = $2, default_allowance_credits = $3, name = COALESCE($4, name), updated_at = $5 WHERE org_id = $1`,
          [snapshot.orgId, revision, snapshot.defaultAllowanceCredits, snapshot.name ?? null, now],
        );
      }
      await client.query("COMMIT");
      return { revision, changed, removed };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}
