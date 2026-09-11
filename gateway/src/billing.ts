import { db } from "./db.js";
import { SubscriberError } from "./subscriber.js";

// A payer has at most one in-flight or unresolved payment. Never expire an
// unresolved entry automatically: a timeout does not prove that no money moved.
export interface BillingRequests {
  acquire(payer: string, requestId: string): Promise<boolean>;
  submitted(payer: string, requestId: string, host: string, maximumCredits: bigint): Promise<void>;
  release(payer: string, requestId: string): Promise<void>;
}

export class MemoryBillingRequests implements BillingRequests {
  private active = new Map<string, string>();
  async acquire(payer: string, requestId: string) {
    payer = payer.toLowerCase();
    if (this.active.has(payer)) return false;
    this.active.set(payer, requestId); return true;
  }
  async submitted() {}
  async release(payer: string, requestId: string) {
    if (this.active.get(payer.toLowerCase()) === requestId) this.active.delete(payer.toLowerCase());
  }
}

export class PgBillingRequests implements BillingRequests {
  constructor(private pool = db()) {}
  async acquire(payer: string, requestId: string) {
    const { rows } = await this.pool.query(
      `INSERT INTO billing_requests (payer, request_id, created_at) VALUES ($1,$2,$3)
       ON CONFLICT (payer) DO NOTHING RETURNING payer`, [payer.toLowerCase(), requestId, Date.now()]);
    return rows.length === 1;
  }
  async submitted(payer: string, requestId: string, host: string, maximumCredits: bigint) {
    const result = await this.pool.query(
      `UPDATE billing_requests SET submitted=true, host=$3, maximum_credits=$4 WHERE payer=$1 AND request_id=$2`,
      [payer.toLowerCase(), requestId, host, String(maximumCredits)]);
    if (result.rowCount !== 1) throw new Error("Billing reservation is missing");
  }
  async release(payer: string, requestId: string) {
    await this.pool.query(`DELETE FROM billing_requests WHERE payer=$1 AND request_id=$2`, [payer.toLowerCase(), requestId]);
  }
}

export function boundedCompletion(body: Record<string, unknown>) {
  const messages = body.messages;
  const limit = body.max_tokens ?? body.max_completion_tokens ?? 512;
  if (!Array.isArray(messages) || !messages.length || messages.length > 64 ||
      messages.some(m => !m || typeof m.content !== "string" || !["system", "user", "assistant", "tool"].includes(m.role)) ||
      !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 4096 || (body.n != null && body.n !== 1)) {
    throw new SubscriberError(400, "invalid_request", "Send text messages and a max_tokens limit between 1 and 4096; one completion per request.");
  }
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > 65_536) throw new SubscriberError(413, "invalid_request", "The request exceeds the 64 KB text limit.");
  // A conservative byte-based token ceiling plus message-template overhead.
  // Reserve the ceiling; charge only the reported usage after generation.
  return { body: { ...body, stream: false, n: 1, max_tokens: Number(limit), max_completion_tokens: Number(limit) },
    promptCeiling: bytes + 1024 + messages.length * 64, completionCeiling: Number(limit) };
}
