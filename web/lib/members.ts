import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { recoverMessageAddress } from "viem";
import { db, dbEnabled, ensureSchema } from "./db";

// Team membership + allowances. Same storage pattern as quorum-keys.ts:
// gitignored JSON under .data, 0600, TOR_MEMBERS_DIR override for tests.
// Identity-adjacent state lives HERE (web); the gateway only enforces numeric
// caps synced to it (see gateway spendCaps). Nothing is silently skipped.

// --- Types -----------------------------------------------------------------

// Prescoped roles (prescribed, enforced server-side everywhere below):
// - owner: everything, incl. managing owners, removing anyone, org defaults.
// - manager: invite members/managers, set allowances, decide increases.
//   Cannot touch roles, remove anyone, or change org defaults.
// - member: chat within allowance, request increases.
export type MemberRole = "owner" | "manager" | "member";

/// @notice Rank for privilege comparison (higher acts on lower-or-equal, never above).
export function roleRank(role: MemberRole): number {
  return role === "owner" ? 2 : role === "manager" ? 1 : 0;
}
export type MemberStatus = "active" | "invited" | "removed";

export interface Member {
  did: string; // Privy DID, stable identity
  email?: string;
  walletAddress: string; // checksummed EVM address — approval signer identity
  role: MemberRole; // owner | manager | member (prescoped, server-enforced)
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
  creatorWallet?: string; // who created it (lowercased) — visibility filter, not auth
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
      orgs[r.id] = { orgId: r.id, defaultAllowanceCredits: r.default_allowance_credits != null ? Number(r.default_allowance_credits) : undefined, periodDays: r.period_days, members: [], creatorWallet: r.creator_wallet ?? undefined };
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
        `INSERT INTO team_orgs (id, default_allowance_credits, period_days, creator_wallet) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET default_allowance_credits = EXCLUDED.default_allowance_credits, period_days = EXCLUDED.period_days,
           creator_wallet = COALESCE(team_orgs.creator_wallet, EXCLUDED.creator_wallet)`,
        [id, o.defaultAllowanceCredits ?? null, o.periodDays, o.creatorWallet ?? null],
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

/// @notice Record who created the org (once — first writer wins). Powers the
/// "my teams" filter so strangers never see your orgs and vice versa.
export async function setOrgCreator(orgId: string, wallet: string): Promise<void> {
  const meta = await ensureOrg(orgId);
  if (!meta.creatorWallet) {
    meta.creatorWallet = wallet.toLowerCase();
    const s = await read();
    s.orgs[orgId] = meta;
    await write(s);
  }
}

/// @notice Orgs visible to a verified login: created by it, an active membership
/// (Privy subject or linked wallet), or a pending invite to its login email.
/// Anything else (other people's orgs, ancient test junk) stays invisible.
export async function visibleOrgIds(identity: { userId: string; wallets: string[]; emails?: string[] }): Promise<Set<string>> {
  const out = new Set<string>();
  const wallets = identity.wallets.map((w) => w.toLowerCase());
  const emails = (identity.emails ?? []).map((e) => e.toLowerCase());
  const s = await read();
  for (const [id, o] of Object.entries(s.orgs)) {
    if (o.creatorWallet && wallets.includes(o.creatorWallet)) out.add(id);
    else if (o.members.some((m) => m.status === "active" && (m.did === identity.userId || (!!m.walletAddress && wallets.includes(m.walletAddress.toLowerCase()))))) out.add(id);
    else if (o.members.some((m) => m.status === "invited" && !!m.email && emails.includes(m.email.toLowerCase()))) out.add(id);
  }
  return out;
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

/// @notice Active member by signer wallet (case-insensitive). The identity root
/// for every role check below.
export async function memberByWallet(orgId: string, wallet: string): Promise<Member | null> {
  const meta = await getOrgMeta(orgId);
  return meta?.members.find((m) => m.status === "active" && m.walletAddress.toLowerCase() === wallet.toLowerCase()) ?? null;
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

/// @notice Email-only invite: creates an "invited" row with no wallet. The invitee
/// claims it later by proving wallet ownership (claimInvite), or the owner binds
/// a wallet via setMemberWallet. Invited members resolve 0 spend (nothing to debit).
export async function inviteMember(
  orgId: string,
  m: { email: string; role: MemberRole; allowanceCredits?: number },
): Promise<Member> {
  const email = m.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("valid email required");
  const meta = await ensureOrg(orgId);
  const bootstrapping = !meta.members.some((x) => x.role === "owner" && x.status === "active");
  if (!bootstrapping && m.role !== "member" && m.role !== "manager") {
    throw new Error("invites are member|manager (owners join by wallet)");
  }
  const did = `email:${email}`;
  const existing = meta.members.find((x) => x.did === did || (x.email?.toLowerCase() === email && x.status !== "removed"));
  if (existing) throw new Error("that email is already invited or active");
  const member: Member = {
    did,
    email,
    walletAddress: "",
    role: m.role,
    allowanceCredits: m.allowanceCredits,
    periodStart: Date.now(),
    status: "invited",
    createdAt: Date.now(),
  };
  meta.members.push(member);
  const s = await read();
  s.orgs[orgId] = meta;
  await write(s);
  return member;
}

/// @notice Claim an email invite by proving wallet ownership (EIP-191 over the
/// canonical claim message). Binds did + wallet, activates. Rejects if the
/// wallet already belongs to an active member anywhere in the org.
export async function claimInvite(
  orgId: string,
  email: string,
  did: string,
  walletAddress: string,
  signature: string,
  message: string,
  now = Date.now(),
): Promise<Member> {
  const em = email.trim().toLowerCase();
  const parsed = parseActionMessage(message);
  if (!parsed || parsed.action !== "invite-claim") throw new Error("wrong action");
  const expires = Number((message.match(/^expires: (\d+)$/m) ?? [])[1]);
  if (message !== inviteClaimMessage(orgId, em, did, walletAddress, expires)) {
    throw new Error("signature does not match this claim");
  }
  if (!Number.isFinite(expires) || now > expires) throw new Error("claim expired, sign again");
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    throw new Error("bad signature");
  }
  if (signer.toLowerCase() !== walletAddress.toLowerCase()) throw new Error("signer must own the claimed wallet");
  const s = await read();
  const meta = s.orgs[orgId];
  const inv = meta?.members.find((x) => x.status === "invited" && (x.email?.toLowerCase() === em || x.did === `email:${em}`));
  if (!inv) throw new Error("no pending invite for that email");
  if (meta.members.some((x) => x.status === "active" && x.walletAddress.toLowerCase() === walletAddress.toLowerCase())) {
    throw new Error("wallet already active in this org");
  }
  if (meta.members.some((x) => x.did === did && x.status === "active")) throw new Error("did already active");
  inv.did = did;
  inv.walletAddress = walletAddress;
  inv.status = "active";
  inv.periodStart = Date.now();
  await write(s);
  return inv;
}

/// @notice Owner rebinds a member's wallet (e.g. invitee shares it late).
/// Caller verifies owner rank.
export async function setMemberWallet(orgId: string, did: string, walletAddress: string): Promise<Member> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) throw new Error("wallet must be 0x + 40 hex");
  const s = await read();
  const m = s.orgs[orgId]?.members.find((x) => x.did === did && x.status !== "removed");
  if (!m) throw new Error("member not found");
  m.walletAddress = walletAddress;
  if (m.status === "invited") {
    m.status = "active";
    m.periodStart = Date.now();
  }
  await write(s);
  return m;
}

export async function setMemberAllowance(orgId: string, did: string, allowanceCredits: number | undefined): Promise<Member> {
  const s = await read();
  const meta = s.orgs[orgId];
  const m = meta?.members.find((x) => x.did === did && x.status !== "removed");
  if (!m) throw new Error("member not found");
  m.allowanceCredits = allowanceCredits;
  m.periodStart = Date.now(); // new cap starts a fresh period (documented, Anthropic-style upsert)
  await write(s);
  return m;
}

export async function setMemberRole(orgId: string, did: string, role: MemberRole): Promise<Member> {
  const s = await read();
  const meta = s.orgs[orgId];
  const m = meta?.members.find((x) => x.did === did && x.status !== "removed");
  if (!m) throw new Error("member not found");
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
  const m = s.orgs[orgId]?.members.find((x) => x.did === did && x.status !== "removed");
  if (!m) throw new Error("member not found");
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

/// @notice Materialize a member's effective allowance for the onchain mirror.
/// Infinity (unlimited) -> null (uncapped onchain). Removed/invited -> 0
/// (deny-all onchain; claim/binds re-mirror after activation).
export function spendCapFor(meta: OrgMeta, did: string): { capCredits: number | null; periodDays: number } {
  const eff = effectiveAllowance(meta, did);
  return { capCredits: eff === Infinity ? null : eff, periodDays: meta.periodDays };
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

export { approvalMessage, inviteClaimMessage, memberActionMessage, parseActionMessage, ruleDecisionMessage, stableJson } from "./member-messages";
export type { DecisionSubject, RuleDecisionSubject } from "./member-messages";
import { inviteClaimMessage, parseActionMessage, ruleDecisionMessage, stableJson } from "./member-messages";

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

// --- Org rules (firm policy) + rule-change intents ---------------------------
// Prescription: owners AND managers may PROPOSE; only owners DECIDE. Approval
// applies the rule locally and the route syncs it to gateway enforcement.
// Kinds: daily_cap {credits|null}, models {models: string[]|null},
// per_tx_cap {usd|null} (display mirror; the Privy per-tx policy is set at creation).

export type RuleKind = "daily_cap" | "models" | "regions" | "verified" | "rate_limit" | "hosts" | "per_tx_cap";

export interface OrgRules {
  orgId: string;
  dailyCapCredits?: number;
  allowedModels?: string[] | null;
  allowedRegions?: string[] | null;
  requireVerified?: boolean;
  rateLimitPerMin?: number;
  pinnedHosts?: string[] | null;
  perTxCapUsd?: number;
  updatedAt: number;
}

export type RuleStatus = "pending" | "approved" | "denied";

export interface RuleChange {
  id: string;
  orgId: string;
  kind: RuleKind;
  payload: Record<string, unknown>;
  status: RuleStatus;
  createdAt: number;
  createdByDid: string;
  decidedAt?: number;
  decidedByDid?: string;
  decision?: "approve" | "deny";
  decisionSignature?: string;
  decisionSigner?: string;
  decisionMessage?: string;
  decisionExpires?: number;
}

const RULE_KINDS: RuleKind[] = ["daily_cap", "models", "regions", "verified", "rate_limit", "hosts", "per_tx_cap"];

export function validateRulePayload(kind: string, payload: Record<string, unknown>): void {
  if (!(RULE_KINDS as string[]).includes(kind)) throw new Error(`unknown rule kind (want ${RULE_KINDS.join("|")})`);
  if (kind === "daily_cap") {
    const c = payload.credits;
    if (c !== null && c !== undefined && (!Number.isFinite(c as number) || (c as number) < 0)) {
      throw new Error("daily_cap.credits must be a non-negative number or null (unlimited)");
    }
  }
  if (kind === "models") {
    const m = payload.models;
    if (m !== null && m !== undefined && (!Array.isArray(m) || !(m as unknown[]).every((x) => typeof x === "string" && x))) {
      throw new Error("models.models must be a string array or null (all models)");
    }
  }
  if (kind === "regions") {
    const r = payload.regions;
    if (r !== null && r !== undefined && (!Array.isArray(r) || !(r as unknown[]).every((x) => typeof x === "string" && /^[a-z]{2}-[a-z]+$/.test(x)))) {
      throw new Error("regions.regions must be an array of cc-name slugs (e.g. us-oregon) or null (all regions)");
    }
  }
  if (kind === "verified") {
    if (typeof payload.only !== "boolean") throw new Error("verified.only must be true or false");
  }
  if (kind === "rate_limit") {
    const p = payload.perMin;
    if (p !== null && p !== undefined && (!Number.isInteger(p as number) || (p as number) <= 0)) {
      throw new Error("rate_limit.perMin must be a positive integer or null (unlimited)");
    }
  }
  if (kind === "hosts") {
    const h = payload.hosts;
    if (h !== null && h !== undefined && (!Array.isArray(h) || !(h as unknown[]).every((x) => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x)))) {
      throw new Error("hosts.hosts must be an array of 0x host addresses or null (any host)");
    }
  }
  if (kind === "per_tx_cap") {
    const u = payload.usd;
    if (u !== null && u !== undefined && (!Number.isFinite(u as number) || (u as number) <= 0)) {
      throw new Error("per_tx_cap.usd must be a positive number or null (no cap)");
    }
  }
}

interface RulesFile {
  rules: Record<string, OrgRules>;
  changes: Record<string, RuleChange>;
}

async function readRules(): Promise<RulesFile> {
  if (!dbEnabled()) {
    try {
      const raw = JSON.parse(readFileSync(rulesPath(), "utf8")) as RulesFile;
      return { rules: raw.rules ?? {}, changes: raw.changes ?? {} };
    } catch {
      return { rules: {}, changes: {} };
    }
  }
  await ensureSchema(join(process.cwd(), "schema.sql"));
  const q = db();
  const rules: Record<string, OrgRules> = {};
  const { rows: ro } = await q.query(`SELECT * FROM org_rules`);
  for (const r of ro) {
    rules[r.org_id] = {
      orgId: r.org_id,
      dailyCapCredits: r.daily_cap_credits != null ? Number(r.daily_cap_credits) : undefined,
      allowedModels: r.allowed_models == null ? undefined : (typeof r.allowed_models === "string" ? JSON.parse(r.allowed_models) : r.allowed_models),
      allowedRegions: r.allowed_regions == null ? undefined : (typeof r.allowed_regions === "string" ? JSON.parse(r.allowed_regions) : r.allowed_regions),
      requireVerified: r.require_verified ?? undefined,
      rateLimitPerMin: r.rate_limit_per_min != null ? Number(r.rate_limit_per_min) : undefined,
      pinnedHosts: r.pinned_hosts == null ? undefined : (typeof r.pinned_hosts === "string" ? JSON.parse(r.pinned_hosts) : r.pinned_hosts),
      perTxCapUsd: r.per_tx_cap_usd != null ? Number(r.per_tx_cap_usd) : undefined,
      updatedAt: Number(r.updated_at),
    };
  }
  const changes: Record<string, RuleChange> = {};
  const { rows: rc } = await q.query(`SELECT * FROM rule_changes`);
  for (const r of rc) {
    changes[r.id] = {
      id: r.id, orgId: r.org_id, kind: r.kind,
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : (r.payload ?? {}),
      status: r.status, createdAt: Number(r.created_at), createdByDid: r.created_by_did ?? "",
      decidedAt: r.decided_at != null ? Number(r.decided_at) : undefined,
      decidedByDid: r.decided_by_did ?? undefined,
      decision: r.decision ?? undefined,
      decisionSignature: r.decision_signature ?? undefined,
      decisionSigner: r.decision_signer ?? undefined,
      decisionMessage: r.decision_message ?? undefined,
      decisionExpires: r.decision_expires != null ? Number(r.decision_expires) : undefined,
    };
  }
  return { rules, changes };
}

function rulesPath(): string {
  const dir = process.env.TOR_MEMBERS_DIR ?? join(process.cwd(), ".data");
  return join(dir, "rules.json");
}

async function writeRules(s: RulesFile): Promise<void> {
  if (!dbEnabled()) {
    const p = rulesPath();
    mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {}
    return;
  }
  await ensureSchema(join(process.cwd(), "schema.sql"));
  const q = db();
  for (const [id, o] of Object.entries(s.rules)) {
    await q.query(
      `INSERT INTO org_rules (org_id, daily_cap_credits, allowed_models, allowed_regions, require_verified, rate_limit_per_min, pinned_hosts, per_tx_cap_usd, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (org_id) DO UPDATE SET daily_cap_credits = EXCLUDED.daily_cap_credits,
         allowed_models = EXCLUDED.allowed_models, allowed_regions = EXCLUDED.allowed_regions,
         require_verified = EXCLUDED.require_verified, rate_limit_per_min = EXCLUDED.rate_limit_per_min,
         pinned_hosts = EXCLUDED.pinned_hosts, per_tx_cap_usd = EXCLUDED.per_tx_cap_usd,
         updated_at = EXCLUDED.updated_at`,
      [id, o.dailyCapCredits ?? null, o.allowedModels === undefined ? null : JSON.stringify(o.allowedModels),
        o.allowedRegions === undefined ? null : JSON.stringify(o.allowedRegions), o.requireVerified ?? null,
        o.rateLimitPerMin ?? null, o.pinnedHosts === undefined ? null : JSON.stringify(o.pinnedHosts),
        o.perTxCapUsd ?? null, o.updatedAt],
    );
  }
  for (const [id, r] of Object.entries(s.changes)) {
    await q.query(
      `INSERT INTO rule_changes (id, org_id, kind, payload, status, created_at, created_by_did, decided_at,
         decided_by_did, decision, decision_signature, decision_signer, decision_message, decision_expires)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, decided_at = EXCLUDED.decided_at,
         decided_by_did = EXCLUDED.decided_by_did, decision = EXCLUDED.decision,
         decision_signature = EXCLUDED.decision_signature, decision_signer = EXCLUDED.decision_signer,
         decision_message = EXCLUDED.decision_message, decision_expires = EXCLUDED.decision_expires`,
      [id, r.orgId, r.kind, JSON.stringify(r.payload), r.status, r.createdAt, r.createdByDid, r.decidedAt ?? null,
        r.decidedByDid ?? null, r.decision ?? null, r.decisionSignature ?? null, r.decisionSigner ?? null,
        r.decisionMessage ?? null, r.decisionExpires ?? null],
    );
  }
}

export async function getRules(orgId: string): Promise<OrgRules> {
  const s = await readRules();
  return s.rules[orgId] ?? { orgId, updatedAt: 0 };
}

export async function listRuleChanges(orgId: string, status?: RuleStatus): Promise<RuleChange[]> {
  const s = await readRules();
  return Object.values(s.changes)
    .filter((r) => r.orgId === orgId && (!status || r.status === status))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function applyRule(o: OrgRules, kind: RuleKind, payload: Record<string, unknown>): OrgRules {
  const next: OrgRules = { ...o, updatedAt: Date.now() };
  if (kind === "daily_cap") next.dailyCapCredits = (payload.credits as number | null) ?? undefined;
  if (kind === "models") next.allowedModels = (payload.models as string[] | null) ?? undefined;
  if (kind === "regions") next.allowedRegions = (payload.regions as string[] | null) ?? undefined;
  if (kind === "verified") next.requireVerified = (payload.only as boolean) ?? undefined;
  if (kind === "rate_limit") next.rateLimitPerMin = (payload.perMin as number | null) ?? undefined;
  if (kind === "hosts") next.pinnedHosts = (payload.hosts as string[] | null) ?? undefined;
  if (kind === "per_tx_cap") next.perTxCapUsd = (payload.usd as number | null) ?? undefined;
  return next;
}

/// @notice Propose a rule change. Caller must verify the proposer is owner/manager
/// (rank 1+) and embed createdByDid — the store trusts but verifies nothing.
export async function proposeRuleChange(orgId: string, kind: string, payload: Record<string, unknown>, createdByDid: string): Promise<RuleChange> {
  validateRulePayload(kind, payload);
  if (!createdByDid) throw new Error("createdByDid required");
  const s = await readRules();
  const id = `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const r: RuleChange = { id, orgId, kind: kind as RuleKind, payload, status: "pending", createdAt: Date.now(), createdByDid };
  s.changes[id] = r;
  await writeRules(s);
  return r;
}

/// @notice Direct set (owner-only — caller verifies rank 2). One signature,
/// applied + caller syncs to gateway. Same validation and binding as propose,
/// action "rule-set" instead of the two-step propose/decide dance.
export async function setRuleDirect(
  orgId: string,
  kind: string,
  payload: Record<string, unknown>,
  decidedByDid: string,
  ownerWallet: string,
  signature: string,
  message: string,
  now = Date.now(),
): Promise<OrgRules> {
  validateRulePayload(kind, payload);
  const ok = await verifyApprovalSignature(message, signature, ownerWallet);
  if (!ok) throw new Error("signature is not from the recorded owner wallet");
  const payloadJson = stableJson(payload);
  const exp = Number((message.match(/^expires: (\d+)$/m) ?? [])[1]);
  if (!Number.isFinite(exp) || now > exp) throw new Error("approval expired, sign again");
  const lines = [`tor-team:rule-set`, `expires: ${exp}`, `kind: ${kind}`, `orgId: ${orgId}`, `payload: ${payloadJson}`];
  if (message !== lines.join("\n")) throw new Error("signature does not match this rule set");
  const s = await readRules();
  const cur = s.rules[orgId] ?? { orgId, updatedAt: 0 };
  s.rules[orgId] = applyRule(cur, kind as RuleKind, payload);
  // Recorded in history as an approved self-decision (audit-complete).
  const id = `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  s.changes[id] = {
    id, orgId, kind: kind as RuleKind, payload, status: "approved", createdAt: now, createdByDid: decidedByDid,
    decidedAt: now, decidedByDid, decision: "approve", decisionSignature: signature,
    decisionSigner: ownerWallet, decisionMessage: message, decisionExpires: exp,
  };
  await writeRules(s);
  return s.rules[orgId];
}

/// @notice Decide (owner-only — caller verifies rank 2). Approval applies immediately.
export async function decideRuleChange(
  id: string,
  decision: "approve" | "deny",
  decidedByDid: string,
  ownerWallet: string,
  signature: string,
  message: string,
  now = Date.now(),
): Promise<RuleChange> {
  const s = await readRules();
  const r = s.changes[id];
  if (!r) throw new Error("rule change not found");
  if (r.status !== "pending") throw new Error(`already ${r.status}`);
  const ok = await verifyApprovalSignature(message, signature, ownerWallet);
  if (!ok) throw new Error("signature is not from the recorded owner wallet");
  const expected = ruleDecisionMessage(
    { id, orgId: r.orgId, kind: r.kind, payloadJson: stableJson(r.payload) },
    decision,
    Number((message.match(/^expires: (\d+)$/m) ?? [])[1]),
  );
  if (message !== expected) throw new Error("signature does not match this decision");
  const exp = Number((message.match(/^expires: (\d+)$/m) ?? [])[1]);
  if (!Number.isFinite(exp) || now > exp) throw new Error("approval expired, sign again");
  r.status = decision === "approve" ? "approved" : "denied";
  r.decidedAt = now;
  r.decidedByDid = decidedByDid;
  r.decision = decision;
  r.decisionSignature = signature;
  r.decisionSigner = ownerWallet;
  r.decisionMessage = message;
  r.decisionExpires = exp;
  if (r.status === "approved") {
    const cur = s.rules[r.orgId] ?? { orgId: r.orgId, updatedAt: 0 };
    s.rules[r.orgId] = applyRule(cur, r.kind, r.payload);
  }
  await writeRules(s);
  return r;
}
