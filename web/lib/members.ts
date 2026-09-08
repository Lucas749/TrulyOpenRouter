import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { recoverMessageAddress } from "viem";
import { db, dbEnabled, ensureSchema } from "./db";

// Team membership + allowances. Same storage pattern as quorum-keys.ts:
// gitignored JSON under .data, 0600, TOR_MEMBERS_DIR override for tests.
// Identity-adjacent state lives HERE (web); the gateway only enforces numeric
// caps synced to it (see gateway spendCaps). Nothing is silently skipped.

// --- Types -----------------------------------------------------------------

export type MemberRole = "owner" | "member";
export type MemberStatus = "active" | "removed";

export interface Member {
  did: string; // Privy DID, stable identity
  email?: string;
  walletAddress: string; // checksummed EVM address, approval signer identity
  role: MemberRole;
  keyPrefix?: string; // bound tor API key prefix (spend attribution via receipts)
  allowanceCredits?: number; // per-period override; undefined = inherit org default
  periodStart: number; // ms epoch of current allowance period
  status: MemberStatus;
  createdAt: number;
}

export interface OrgMeta {
  orgId: string;
  defaultAllowanceCredits?: number; // org default; undefined = unlimited
  periodDays: number;
  members: Member[];
}

export type RequestStatus = "pending" | "approved" | "denied";

export interface IncreaseRequest {
  id: string;
  orgId: string;
  memberDid: string;
  amountCredits: number;
  status: RequestStatus;
  createdAt: number;
  decidedAt?: number;
  decidedByDid?: string;
  // Wallet-signature audit trail (owner personal_sign, verified server-side):
  decisionSignature?: string;
  decisionSigner?: string; // recovered address, must equal owner's wallet
  decisionMessage?: string;
  decisionExpires?: number;
}

interface MembersFile {
  orgs: Record<string, OrgMeta>;
  requests: Record<string, IncreaseRequest>;
}

// --- Store -----------------------------------------------------------------
// Postgres when DATABASE_URL is set (RDS in prod), else gitignored JSON.
// Whole-state load/save keeps every function below identical on both backends;
// teams are tiny (dozens of rows), so this stays fast. Same read-modify-write
// race as the file version, acceptable at this scale, noted honestly.

interface MemberBackend {
  load(): Promise<MembersFile>;
  save(s: MembersFile): Promise<void>;
}

function storePath(): string {
  const dir = process.env.TOR_MEMBERS_DIR ?? join(process.cwd(), ".data");
  return join(dir, "members.json");
}

const fileBackend: MemberBackend = {
  async load(): Promise<MembersFile> {
    try {
      const raw = JSON.parse(readFileSync(storePath(), "utf8")) as MembersFile;
      return { orgs: raw.orgs ?? {}, requests: raw.requests ?? {} };
    } catch {
      return { orgs: {}, requests: {} };
    }
  },
  async save(s: MembersFile): Promise<void> {
    const p = storePath();
    mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {}
  },
};

function rowToMember(r: any): Member {
  return {
    did: r.did,
    email: r.email ?? undefined,
    walletAddress: r.wallet_address,
    role: r.role,
    keyPrefix: r.key_prefix ?? undefined,
    allowanceCredits: r.allowance_credits != null ? Number(r.allowance_credits) : undefined,
    periodStart: Number(r.period_start),
    status: r.status,
    createdAt: Number(r.added_at),
  };
}

function rowToRequest(r: any): IncreaseRequest {
  return {
    id: r.id,
    orgId: r.org_id,
    memberDid: r.member_did,
    amountCredits: Number(r.amount_credits),
    status: r.status,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at != null ? Number(r.decided_at) : undefined,
    decidedByDid: r.decided_by_did ?? undefined,
    decisionSignature: r.decision_signature ?? undefined,
    decisionSigner: r.decision_signer ?? undefined,
    decisionMessage: r.decision_message ?? undefined,
    decisionExpires: r.decision_expires != null ? Number(r.decision_expires) : undefined,
  };
}

const pgBackend: MemberBackend = {
  async load(): Promise<MembersFile> {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    const q = db();
    const orgs: Record<string, OrgMeta> = {};
    const { rows: o } = await q.query(`SELECT * FROM team_orgs`);
    for (const r of o) {
      orgs[r.id] = { orgId: r.id, defaultAllowanceCredits: r.default_allowance_credits != null ? Number(r.default_allowance_credits) : undefined, periodDays: r.period_days, members: [] };
    }
    const { rows: m } = await q.query(`SELECT * FROM team_members`);
    for (const r of m) {
      (orgs[r.org_id] ??= { orgId: r.org_id, periodDays: 30, members: [] }).members.push(rowToMember(r));
    }
    const requests: Record<string, IncreaseRequest> = {};
    const { rows: rq } = await q.query(`SELECT * FROM increase_requests`);
    for (const r of rq) requests[r.id] = rowToRequest(r);
    return { orgs, requests };
  },
  async save(s: MembersFile): Promise<void> {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    const q = db();
    for (const [id, o] of Object.entries(s.orgs)) {
      await q.query(
        `INSERT INTO team_orgs (id, default_allowance_credits, period_days) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET default_allowance_credits = EXCLUDED.default_allowance_credits, period_days = EXCLUDED.period_days`,
        [id, o.defaultAllowanceCredits ?? null, o.periodDays],
      );
      for (const m of o.members) {
        await q.query(
          `INSERT INTO team_members (org_id, did, email, wallet_address, role, status, allowance_credits, key_prefix, period_start, added_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (org_id, did) DO UPDATE SET email = EXCLUDED.email, wallet_address = EXCLUDED.wallet_address,
             role = EXCLUDED.role, status = EXCLUDED.status, allowance_credits = EXCLUDED.allowance_credits,
             key_prefix = EXCLUDED.key_prefix, period_start = EXCLUDED.period_start`,
          [id, m.did, m.email ?? null, m.walletAddress, m.role, m.status, m.allowanceCredits ?? null, m.keyPrefix ?? null, m.periodStart, m.createdAt],
        );
      }
    }
    for (const [id, r] of Object.entries(s.requests)) {
      await q.query(
        `INSERT INTO increase_requests (id, org_id, member_did, amount_credits, status, created_at, decided_at, decided_by_did,
           decision_signature, decision_signer, decision_message, decision_expires)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, decided_at = EXCLUDED.decided_at,
           decided_by_did = EXCLUDED.decided_by_did, decision_signature = EXCLUDED.decision_signature,
           decision_signer = EXCLUDED.decision_signer, decision_message = EXCLUDED.decision_message,
           decision_expires = EXCLUDED.decision_expires`,
        [id, r.orgId, r.memberDid, r.amountCredits, r.status, r.createdAt, r.decidedAt ?? null, r.decidedByDid ?? null,
          r.decisionSignature ?? null, r.decisionSigner ?? null, r.decisionMessage ?? null, r.decisionExpires ?? null],
      );
    }
  },
};

function backend(): MemberBackend {
  return dbEnabled() ? pgBackend : fileBackend;
}

async function read(): Promise<MembersFile> {
  return backend().load();
}

async function write(s: MembersFile): Promise<void> {
  return backend().save(s);
}

export async function getOrgMeta(orgId: string): Promise<OrgMeta | null> {
  return (await read()).orgs[orgId] ?? null;
}

export async function ensureOrg(orgId: string, periodDays = 30): Promise<OrgMeta> {
  const s = await read();
  if (!s.orgs[orgId]) s.orgs[orgId] = { orgId, periodDays, members: [] };
  await write(s);
  return s.orgs[orgId];
}

export async function setOrgDefault(orgId: string, allowanceCredits: number | undefined): Promise<OrgMeta> {
  const meta = await ensureOrg(orgId);
  meta.defaultAllowanceCredits = allowanceCredits;
  const s = await read();
  s.orgs[orgId] = meta;
  await write(s);
  return meta;
}

export async function getMember(orgId: string, did: string): Promise<Member | null> {
  return (await getOrgMeta(orgId))?.members.find((m) => m.did === did) ?? null;
}

export async function addMember(orgId: string, m: Omit<Member, "status" | "createdAt" | "periodStart"> & { periodStart?: number }): Promise<Member> {
  const meta = await ensureOrg(orgId);
  const existing = meta.members.find((x) => x.did === m.did);
  if (existing) {
    if (existing.status === "removed") {
      Object.assign(existing, { ...m, status: "active" as const, createdAt: Date.now() });
    } else {
      throw new Error("member already active");
    }
  } else {
    meta.members.push({ ...m, periodStart: m.periodStart ?? Date.now(), status: "active", createdAt: Date.now() });
  }
  const s = await read();
  s.orgs[orgId] = meta;
  await write(s);
  return meta.members.find((x) => x.did === m.did)!;
}

export async function setMemberAllowance(orgId: string, did: string, allowanceCredits: number | undefined): Promise<Member> {
  const s = await read();
  const meta = s.orgs[orgId];
  const m = meta?.members.find((x) => x.did === did && x.status === "active");
  if (!m) throw new Error("active member not found");
  m.allowanceCredits = allowanceCredits;
  m.periodStart = Date.now(); // new cap starts a fresh period (documented, Anthropic-style upsert)
  await write(s);
  return m;
}

export async function setMemberRole(orgId: string, did: string, role: MemberRole): Promise<Member> {
  const s = await read();
  const meta = s.orgs[orgId];
  const m = meta?.members.find((x) => x.did === did && x.status === "active");
  if (!m) throw new Error("active member not found");
  if (m.role === "owner" && role === "member") {
    const otherOwners = meta.members.filter((x) => x.role === "owner" && x.did !== did && x.status === "active");
    if (otherOwners.length === 0) throw new Error("cannot demote the last owner");
  }
  m.role = role;
  await write(s);
  return m;
}

export async function removeMember(orgId: string, did: string): Promise<Member> {
  const s = await read();
  const m = s.orgs[orgId]?.members.find((x) => x.did === did && x.status === "active");
  if (!m) throw new Error("active member not found");
  if (m.role === "owner") {
    const otherOwners = s.orgs[orgId].members.filter((x) => x.role === "owner" && x.did !== did && x.status === "active");
    if (otherOwners.length === 0) throw new Error("cannot remove the last owner");
  }
  m.status = "removed";
  await write(s);
  return m;
}

// --- Allowance resolution (Anthropic-style fallback chain) ------------------
// member override -> org default -> unlimited (Infinity). Removed members resolve
// to 0 (deny). Period rollover is computed by the caller from periodStart.

export function effectiveAllowance(meta: OrgMeta, did: string): number {
  const m = meta.members.find((x) => x.did === did);
  if (!m || m.status !== "active") return 0;
  if (m.allowanceCredits !== undefined) return m.allowanceCredits;
  return meta.defaultAllowanceCredits ?? Infinity;
}

export function periodStartFor(meta: OrgMeta, did: string, now = Date.now()): number {
  const m = meta.members.find((x) => x.did === did);
  if (!m) return now;
  const periodMs = meta.periodDays * 86_400_000;
  return now - m.periodStart >= periodMs ? now : m.periodStart;
}

// --- Member-management action messages ---------------------------------------
// Canonical forms live in member-messages.ts (client-safe); re-exported here so
// routes keep one import. Every member mutation is authorized by a Privy
// embedded-wallet personal_sign over these bytes, verified server-side below.

export { approvalMessage, memberActionMessage, parseActionMessage } from "./member-messages";
export type { DecisionSubject } from "./member-messages";
import { parseActionMessage } from "./member-messages";

/// @notice Verifies signer + expiry + that every expected binding is present.
/// Returns the recovered address on success, throws otherwise.
export async function verifyActionMessage(
  message: string,
  signature: string,
  expectedAction: string,
  expected: Record<string, string>,
  now = Date.now(),
): Promise<string> {
  const parsed = parseActionMessage(message);
  if (!parsed || parsed.action !== expectedAction) throw new Error("wrong action");
  for (const [k, v] of Object.entries(expected)) {
    if (parsed.fields[k] !== v) throw new Error(`message does not bind ${k}`);
  }
  if (now > parsed.expires) throw new Error("approval expired, sign again");
  // EIP-191, same envelope Privy useSignMessage produces (viem roundtrip covers
  // CI; live embedded-wallet check is a manual TEST-LIST item).
  return recoverMessageAddress({ message, signature: signature as `0x${string}` });
}

// --- Increase requests -------------------------------------------------------

export async function createIncreaseRequest(orgId: string, memberDid: string, amountCredits: number): Promise<IncreaseRequest> {
  if (!Number.isFinite(amountCredits) || amountCredits <= 0) throw new Error("amount must be positive");
  const s = await read();
  await ensureOrg(orgId);
  const id = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const r: IncreaseRequest = { id, orgId, memberDid, amountCredits, status: "pending", createdAt: Date.now() };
  s.requests[id] = r;
  await write(s);
  return r;
}

export async function getRequest(id: string): Promise<IncreaseRequest | null> {
  return (await read()).requests[id] ?? null;
}

export async function listRequests(orgId: string, status?: RequestStatus): Promise<IncreaseRequest[]> {
  return Object.values((await read()).requests)
    .filter((r) => r.orgId === orgId && (!status || r.status === status))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// --- Wallet-signed decisions -------------------------------------------------
// The owner approves/denies by personal_sign-ing a canonical message with their
// Privy embedded wallet (useSignMessage). Server recovers the signer with viem
// and requires it to equal the recorded owner wallet. Signature + signer are
// stored on the request = the audit trail.

export async function verifyApprovalSignature(message: string, signature: string, expectedWallet: string): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
    return recovered.toLowerCase() === expectedWallet.toLowerCase();
  } catch {
    return false;
  }
}

export async function decideRequest(
  id: string,
  decision: "approve" | "deny",
  decidedByDid: string,
  ownerWallet: string,
  signature: string,
  message: string,
  now = Date.now(),
): Promise<IncreaseRequest> {
  const s = await read();
  const r = s.requests[id];
  if (!r) throw new Error("request not found");
  if (r.status !== "pending") throw new Error(`already ${r.status}`);
  const ok = await verifyApprovalSignature(message, signature, ownerWallet);
  if (!ok) throw new Error("signature is not from the recorded owner wallet");
  if (!message.includes(`request: ${id}`) || !message.includes(`action: ${decision}`)) {
    throw new Error("signature does not match this decision");
  }
  const exp = Number((message.match(/^expires: (\d+)$/m) ?? [])[1]);
  if (!Number.isFinite(exp) || now > exp) throw new Error("approval expired, sign again");
  r.status = decision === "approve" ? "approved" : "denied";
  r.decidedAt = now;
  r.decidedByDid = decidedByDid;
  r.decisionSignature = signature;
  r.decisionSigner = ownerWallet;
  r.decisionMessage = message;
  r.decisionExpires = exp;
  await write(s);
  if (r.status === "approved") {
    // Fresh read/write inside (also resets the allowance period, documented).
    await setMemberAllowance(r.orgId, r.memberDid, r.amountCredits);
  }
  return r;
}
