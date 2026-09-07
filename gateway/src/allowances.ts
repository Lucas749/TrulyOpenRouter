import type { Receipt } from "./receipts.js";

// Member spend allowances, enforced pre-flight in the chat flow.
// Identity (who is in which org, roles, increase requests) lives in web/lib/members.ts;
// THIS store holds only numbers, synced from web via /api/admin/caps authed by
// GATEWAY_ADMIN_TOKEN. Trust boundaries: wallet signature authorizes the change (web),
// admin token authorizes the propagation (gateway). Units: whole credits (see receipts.ts).

export interface SpendCap {
  cap: number;
  periodStart: number; // ms epoch — spend counts from here
  updatedAt: number;
}

export class SpendCapStore {
  private caps = new Map<string, SpendCap>();

  setCap(prefix: string, cap: number, periodStart = Date.now()): SpendCap {
    if (!prefix) throw new Error("prefix required");
    if (!Number.isFinite(cap) || cap < 0) throw new Error("cap must be a non-negative number");
    const rec = { cap, periodStart, updatedAt: Date.now() };
    this.caps.set(prefix, rec);
    return rec;
  }

  removeCap(prefix: string): boolean {
    return this.caps.delete(prefix);
  }

  getCap(prefix: string): SpendCap | null {
    return this.caps.get(prefix) ?? null;
  }
}

/// @notice Sum settled credits for a user handle (`key:<prefix>` or wallet address)
/// since periodStart. Unsettled/amount-less receipts count 0 — only debited spend binds.
export function sumSpent(
  receipts: Pick<Receipt, "user" | "amountCredits" | "ts">[],
  userHandle: string,
  sinceMs: number,
): number {
  let total = 0;
  for (const r of receipts) {
    if (r.user !== userHandle || r.ts < sinceMs) continue;
    const n = Number(r.amountCredits ?? 0);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

/// @notice Pre-flight gate: spent >= cap blocks BEFORE serving. One call can still
/// overshoot slightly (cost is known only after generation) — documented, matches
/// the existing quota style; the onchain vault debit is the final backstop.
export function allowanceExceeded(spent: number, cap: number | undefined): boolean {
  return cap !== undefined && spent >= cap;
}
