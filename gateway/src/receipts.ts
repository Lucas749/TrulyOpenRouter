import { createHash } from "crypto";
import { db } from "./db.js";

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface ReceiptInput {
  promptHash: string;
  completionHash: string;
  modelDigest: string;
  host: string; // host address or "fallback"
  priceWei: string;
  latencyMs: number;
  tokensIn?: number; // from upstream usage; 0 when unreported
  tokensOut?: number;
  amountCredits?: string; // metered settle amount; "0" when unsettled
  modelId?: string; // for per-model aggregates
  user?: string; // payer handle: key:<prefix> or "dev" — pseudonymous, for usage history
  debitTx?: string; // vault debit tx hash (the money proof link)
  hcsSeq?: string; // audit topic sequence (the public proof link)
}

// Money rule (SPEC §7): 1 credit ≡ $0.001 BY DEFINITION. Displays derive $ as
// credits × 0.001 — a defined unit conversion, never a market rate. Onchain wei
// amounts map 1:1 to credit base units at the documented testnet rate.

export interface Receipt extends ReceiptInput {
  id: string; // sha256 over all fields — the verifiable handle
  ts: number;
}

/// @notice Bodies never touch a receipt — hashes only (see privacy split, SPEC §1b…§4).
export function buildReceipt(input: ReceiptInput, ts = Date.now()): Receipt {
  const id = sha256hex(
    [input.promptHash, input.completionHash, input.modelDigest, input.host, input.priceWei, input.latencyMs].join("|"),
  );
  return { ...input, id, ts };
}

export interface ReceiptLog {
  append(r: Receipt): Promise<void>;
  list(limit?: number): Promise<Receipt[]>;
  get(id: string): Promise<Receipt | undefined>;
  /// @notice Patch a receipt after the fact (e.g. settled amount). No-op when unknown.
  annotate(id: string, patch: Partial<Receipt>): Promise<void>;
}

export class MemoryReceiptLog implements ReceiptLog {
  private items: Receipt[] = [];

  async append(r: Receipt): Promise<void> {
    this.items.push(r);
  }

  async list(limit = 50): Promise<Receipt[]> {
    return this.items.slice(-limit).reverse();
  }

  async get(id: string): Promise<Receipt | undefined> {
    return this.items.find((r) => r.id === id);
  }

  async annotate(id: string, patch: Partial<Receipt>): Promise<void> {
    const r = this.items.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }
}

function rowToReceipt(row: any): Receipt {
  const d = typeof row.data === "string" ? JSON.parse(row.data) : (row.data ?? {});
  return {
    id: row.id,
    ts: Number(row.ts),
    promptHash: d.promptHash ?? "",
    completionHash: d.completionHash ?? "",
    modelDigest: d.modelDigest ?? "",
    host: row.host ?? d.host ?? "",
    priceWei: row.price_wei ?? d.priceWei ?? "0",
    latencyMs: d.latencyMs ?? 0,
    ...d,
    amountCredits: row.amount_credits ?? d.amountCredits ?? "0",
    user: row.user ?? d.user,
    debitTx: row.debit_tx ?? d.debitTx,
    hcsSeq: row.hcs_seq != null ? String(row.hcs_seq) : d.hcsSeq,
  };
}

/// @notice Postgres log (DATABASE_URL set). Full receipt in `data` jsonb;
/// hot columns duplicated for indexes. Same interface as memory.
export class PgReceiptLog implements ReceiptLog {
  constructor(private pool?: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) {}

  private q() {
    return this.pool ?? db();
  }

  async append(r: Receipt): Promise<void> {
    await this.q().query(
      `INSERT INTO receipts (id, ts, model, host, payer, "user", price_wei, amount_credits, debit_tx, hcs_seq, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
      [
        r.id, r.ts, (r as any).modelId ?? "", r.host ?? "", (r as any).user ?? "",
        (r as any).user ?? "", String((r as any).priceWei ?? "0"), String((r as any).amountCredits ?? "0"),
        (r as any).debitTx ?? null, (r as any).hcsSeq != null ? Number((r as any).hcsSeq) : null,
        JSON.stringify(r),
      ],
    );
  }

  async list(limit = 50): Promise<Receipt[]> {
    const { rows } = await this.q().query(`SELECT * FROM receipts ORDER BY ts DESC LIMIT $1`, [limit]);
    return rows.map(rowToReceipt);
  }

  async get(id: string): Promise<Receipt | undefined> {
    const { rows } = await this.q().query(`SELECT * FROM receipts WHERE id = $1`, [id]);
    return rows[0] ? rowToReceipt(rows[0]) : undefined;
  }

  async annotate(id: string, patch: Partial<Receipt>): Promise<void> {
    const p = patch as any;
    await this.q().query(
      `UPDATE receipts SET data = data || $2::jsonb,
        amount_credits = COALESCE($3, amount_credits),
        debit_tx = COALESCE($4, debit_tx),
        hcs_seq = COALESCE($5, hcs_seq)
       WHERE id = $1`,
      [
        id, JSON.stringify(p),
        p.amountCredits != null ? String(p.amountCredits) : null,
        p.debitTx ?? null,
        p.hcsSeq != null ? Number(p.hcsSeq) : null,
      ],
    );
  }
}
