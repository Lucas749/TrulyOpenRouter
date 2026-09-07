import type { Receipt } from "./receipts.js";
import { db } from "./db.js";

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

export interface CapStore {
  setCap(prefix: string, cap: number, periodStart?: number): Promise<SpendCap>;
  removeCap(prefix: string): Promise<boolean>;
  getCap(prefix: string): Promise<SpendCap | null>;
}

function checkCap(prefix: string, cap: number): void {
  if (!prefix) throw new Error("prefix required");
  if (!Number.isFinite(cap) || cap < 0) throw new Error("cap must be a non-negative number");
}

export class SpendCapStore implements CapStore {
  private caps = new Map<string, SpendCap>();

  async setCap(prefix: string, cap: number, periodStart = Date.now()): Promise<SpendCap> {
    checkCap(prefix, cap);
    const rec = { cap, periodStart, updatedAt: Date.now() };
    this.caps.set(prefix, rec);
    return rec;
  }

  async removeCap(prefix: string): Promise<boolean> {
    return this.caps.delete(prefix);
  }

  async getCap(prefix: string): Promise<SpendCap | null> {
    return this.caps.get(prefix) ?? null;
  }
}

/// @notice Postgres caps (DATABASE_URL set). Same interface as memory.
export class PgCapStore implements CapStore {
  constructor(private pool?: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) {}

  private q() {
    return this.pool ?? db();
  }

  async setCap(prefix: string, cap: number, periodStart = Date.now()): Promise<SpendCap> {
    checkCap(prefix, cap);
    const rec = { cap, periodStart, updatedAt: Date.now() };
    await this.q().query(
      `INSERT INTO spend_caps (prefix, cap, period_start) VALUES ($1,$2,$3)
       ON CONFLICT (prefix) DO UPDATE SET cap = EXCLUDED.cap, period_start = EXCLUDED.period_start`,
      [prefix, cap, periodStart],
    );
    return rec;
  }

  async removeCap(prefix: string): Promise<boolean> {
    const { rows } = await this.q().query(`DELETE FROM spend_caps WHERE prefix = $1 RETURNING prefix`, [prefix]);
    return rows.length > 0;
  }

  async getCap(prefix: string): Promise<SpendCap | null> {
    const { rows } = await this.q().query(`SELECT cap, period_start FROM spend_caps WHERE prefix = $1`, [prefix]);
    if (!rows[0]) return null;
    return { cap: Number(rows[0].cap), periodStart: Number(rows[0].period_start), updatedAt: 0 };
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
