// Canonical message formats + presentation helpers for team spend management.
// CLIENT-SAFE: no fs, no viem, no secrets. Importable from both server routes
// (via members.ts re-export) and browser components. The canonical strings here
// are the trust root, server verifies signatures over EXACTLY these bytes.

// --- Canonical messages (EIP-191 personal_sign via Privy useSignMessage) ------

export function memberActionMessage(action: string, fields: Record<string, string>, expires: number): string {
  const lines = [`tor-team:${action}`];
  for (const k of Object.keys(fields).sort()) lines.push(`${k}: ${fields[k]}`);
  lines.push(`expires: ${expires}`);
  return lines.join("\n");
}

export function parseActionMessage(message: string): { action: string; fields: Record<string, string>; expires: number } | null {
  const lines = message.split("\n");
  const head = lines.shift() ?? "";
  if (!head.startsWith("tor-team:")) return null;
  const fields: Record<string, string> = {};
  let expires = NaN;
  for (const line of lines) {
    const i = line.indexOf(": ");
    if (i < 0) return null;
    const k = line.slice(0, i);
    const v = line.slice(i + 2);
    if (k === "expires") expires = Number(v);
    else fields[k] = v;
  }
  if (!Number.isFinite(expires)) return null;
  return { action: head.slice("tor-team:".length), fields, expires };
}

export interface DecisionSubject {
  id: string;
  orgId: string;
  memberDid: string;
  amountCredits: number;
}

/// @notice Stable JSON (sorted keys, recursive) for binding rule payloads.
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/// @notice Invite claim: the invitee proves wallet ownership. Server matches the
/// email against an invited row. Trust note: email is self-asserted — this binds
/// a PROVEN wallet to an owner-approved email, acceptable for capped testnet
/// spend; the owner can rebind via PATCH wallet at any time.
export function inviteClaimMessage(orgId: string, email: string, did: string, wallet: string, expires: number): string {
  return memberActionMessage("invite-claim", { orgId, email: email.toLowerCase(), did, wallet }, expires);
}

export interface RuleDecisionSubject {
  id: string;
  orgId: string;
  kind: string;
  payloadJson: string;
}

export function ruleDecisionMessage(r: RuleDecisionSubject, decision: "approve" | "deny", expires: number): string {
  return [
    "TrulyOpenRouter rule decision",
    `action: ${decision}`,
    `request: ${r.id}`,
    `org: ${r.orgId}`,
    `kind: ${r.kind}`,
    `payload: ${r.payloadJson}`,
    `expires: ${expires}`,
  ].join("\n");
}

export function approvalMessage(r: DecisionSubject, decision: "approve" | "deny", expires: number): string {
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

// --- Presentation (design tokens: amber >=80%, red at 100%) ------------------

export type SpendState = "none" | "ok" | "warning" | "capped";

export function spendBarState(used: number | null, cap: number | null): { pct: number; state: SpendState; label: string } {
  if (used === null || cap === null) return { pct: 0, state: "none", label: "—" };
  if (cap <= 0) return { pct: 100, state: "capped", label: "capped" };
  const ratio = used / cap;
  if (ratio >= 1) return { pct: 100, state: "capped", label: "capped" };
  if (ratio >= 0.8) return { pct: Math.round(ratio * 100), state: "warning", label: `${Math.round(ratio * 100)}%` };
  return { pct: Math.round(ratio * 100), state: "ok", label: `${Math.round(ratio * 100)}%` };
}

export function shortId(id: string, n = 10): string {
  return id.length > n + 1 ? `${id.slice(0, n)}…` : id;
}
