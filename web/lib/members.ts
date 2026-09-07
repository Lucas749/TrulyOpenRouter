import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { recoverMessageAddress } from "viem";

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
  walletAddress: string; // checksummed EVM address — approval signer identity
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
  decisionSigner?: string; // recovered address — must equal owner's wallet
  decisionMessage?: string;
  decisionExpires?: number;
}

interface MembersFile {
  orgs: Record<string, OrgMeta>;
  requests: Record<string, IncreaseRequest>;
}

// --- Store -----------------------------------------------------------------

function storePath(): string {
  const dir = process.env.TOR_MEMBERS_DIR ?? join(process.cwd(), ".data");
  return join(dir, "members.json");
}

function read(): MembersFile {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as MembersFile;
    return { orgs: raw.orgs ?? {}, requests: raw.requests ?? {} };
  } catch {
    return { orgs: {}, requests: {} };
  }
}

function write(s: MembersFile): void {
  const p = storePath();
  mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {}
}

export function getOrgMeta(orgId: string): OrgMeta | null {
  return read().orgs[orgId] ?? null;
}

export function ensureOrg(orgId: string, periodDays = 30): OrgMeta {
  const s = read();
  if (!s.orgs[orgId]) s.orgs[orgId] = { orgId, periodDays, members: [] };
  write(s);
  return s.orgs[orgId];
}

export function setOrgDefault(orgId: string, allowanceCredits: number | undefined): OrgMeta {
  const meta = ensureOrg(orgId);
  meta.defaultAllowanceCredits = allowanceCredits;
  const s = read();
  s.orgs[orgId] = meta;
  write(s);
  return meta;
}

export function getMember(orgId: string, did: string): Member | null {
  return getOrgMeta(orgId)?.members.find((m) => m.did === did) ?? null;
}

export function addMember(orgId: string, m: Omit<Member, "status" | "createdAt" | "periodStart"> & { periodStart?: number }): Member {
  const meta = ensureOrg(orgId);
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
  const s = read();
  s.orgs[orgId] = meta;
  write(s);
  return meta.members.find((x) => x.did === m.did)!;
}

export function setMemberAllowance(orgId: string, did: string, allowanceCredits: number | undefined): Member {
  const s = read();
  const meta = s.orgs[orgId];
  const m = meta?.members.find((x) => x.did === did && x.status === "active");
  if (!m) throw new Error("active member not found");
  m.allowanceCredits = allowanceCredits;
  m.periodStart = Date.now(); // new cap starts a fresh period (documented, Anthropic-style upsert)
  write(s);
  return m;
}

export function removeMember(orgId: string, did: string): Member {
  const s = read();
  const m = s.orgs[orgId]?.members.find((x) => x.did === did && x.status === "active");
  if (!m) throw new Error("active member not found");
  if (m.role === "owner") {
    const otherOwners = s.orgs[orgId].members.filter((x) => x.role === "owner" && x.did !== did && x.status === "active");
    if (otherOwners.length === 0) throw new Error("cannot remove the last owner");
  }
  m.status = "removed";
  write(s);
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

// --- Increase requests -------------------------------------------------------

export function createIncreaseRequest(orgId: string, memberDid: string, amountCredits: number): IncreaseRequest {
  if (!Number.isFinite(amountCredits) || amountCredits <= 0) throw new Error("amount must be positive");
  const s = read();
  ensureOrg(orgId);
  const id = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const r: IncreaseRequest = { id, orgId, memberDid, amountCredits, status: "pending", createdAt: Date.now() };
  s.requests[id] = r;
  write(s);
  return r;
}

export function getRequest(id: string): IncreaseRequest | null {
  return read().requests[id] ?? null;
}

export function listRequests(orgId: string, status?: RequestStatus): IncreaseRequest[] {
  return Object.values(read().requests)
    .filter((r) => r.orgId === orgId && (!status || r.status === status))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// --- Wallet-signed decisions -------------------------------------------------
// The owner approves/denies by personal_sign-ing a canonical message with their
// Privy embedded wallet (useSignMessage). Server recovers the signer with viem
// and requires it to equal the recorded owner wallet. Signature + signer are
// stored on the request = the audit trail.

export function approvalMessage(r: Pick<IncreaseRequest, "id" | "orgId" | "memberDid" | "amountCredits">, decision: "approve" | "deny", expires: number): string {
  return [
    "TrulyOpenRouter allowance decision",
    `action: ${decision}`,
    `request: ${r.id}`,
    `org: ${r.orgId}`,
    `member: ${r.memberDid}`,
    `newCap: ${r.amountCredits}`,
    `expires: ${expires}`,
  ].join("\n");
}

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
  const s = read();
  const r = s.requests[id];
  if (!r) throw new Error("request not found");
  if (r.status !== "pending") throw new Error(`already ${r.status}`);
  const ok = await verifyApprovalSignature(message, signature, ownerWallet);
  if (!ok) throw new Error("signature is not from the recorded owner wallet");
  if (!message.includes(`request: ${id}`) || !message.includes(`action: ${decision}`)) {
    throw new Error("signature does not match this decision");
  }
  const exp = Number((message.match(/^expires: (\d+)$/m) ?? [])[1]);
  if (!Number.isFinite(exp) || now > exp) throw new Error("approval expired — sign again");
  r.status = decision === "approve" ? "approved" : "denied";
  r.decidedAt = now;
  r.decidedByDid = decidedByDid;
  r.decisionSignature = signature;
  r.decisionSigner = ownerWallet;
  r.decisionMessage = message;
  r.decisionExpires = exp;
  write(s);
  if (r.status === "approved") {
    // Fresh read/write inside (also resets the allowance period — documented).
    setMemberAllowance(r.orgId, r.memberDid, r.amountCredits);
  }
  return r;
}
