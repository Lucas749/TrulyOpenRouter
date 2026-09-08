// Upstream failure tracking (24h rolling window).
// Successes come from the receipt log; only failures need a separate counter.
// reliability = success / (success + fail), null when nothing observed.
import { db } from "./db.js";

const DAY = 86_400_000;
const LATENCY_ALPHA = 0.3;

export interface Health {
  recordFail(address: string, now?: number): Promise<void>;
  fails24h(address: string, now?: number): Promise<number>;
  reliability(success24h: number, address: string, now?: number): Promise<number | null>;
  /// @notice Observed upstream latency EMA (ms), null until first success.
  recordLatency(address: string, ms: number): Promise<void>;
  latencyMs(address: string): Promise<number | null>;
}

export class MemoryHealth implements Health {
  private fails = new Map<string, number[]>();
  private latencyEma = new Map<string, number>();

  async recordFail(address: string, now = Date.now()): Promise<void> {
    const list = this.fails.get(address.toLowerCase()) ?? [];
    list.push(now);
    this.fails.set(address.toLowerCase(), list);
  }

  async fails24h(address: string, now = Date.now()): Promise<number> {
    const list = (this.fails.get(address.toLowerCase()) ?? []).filter((t) => now - t < DAY);
    this.fails.set(address.toLowerCase(), list);
    return list.length;
  }

  async reliability(success24h: number, address: string, now = Date.now()): Promise<number | null> {
    const fails = await this.fails24h(address, now);
    if (success24h + fails === 0) return null;
    return success24h / (success24h + fails);
  }

  async recordLatency(address: string, ms: number): Promise<void> {
    const key = address.toLowerCase();
    const prev = this.latencyEma.get(key);
    this.latencyEma.set(key, prev === undefined ? ms : LATENCY_ALPHA * ms + (1 - LATENCY_ALPHA) * prev);
  }

  async latencyMs(address: string): Promise<number | null> {
    const v = this.latencyEma.get(address.toLowerCase());
    return v === undefined ? null : Math.round(v);
  }
}

/// @notice Postgres health (DATABASE_URL set). One indexed row per failure,
/// one row per host EMA — cheap at chat-call rates, survives restarts.
export class PgHealth implements Health {
  constructor(private pool?: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) {}

  private q() {
    return this.pool ?? db();
  }

  async recordFail(address: string, now = Date.now()): Promise<void> {
    await this.q().query(`INSERT INTO host_fails (host, ts) VALUES ($1,$2)`, [address.toLowerCase(), now]);
  }

  async fails24h(address: string, now = Date.now()): Promise<number> {
    const { rows } = await this.q().query(`SELECT COUNT(*)::int AS n FROM host_fails WHERE host = $1 AND ts > $2`, [
      address.toLowerCase(),
      now - DAY,
    ]);
    return rows[0]?.n ?? 0;
  }

  async reliability(success24h: number, address: string, now = Date.now()): Promise<number | null> {
    const fails = await this.fails24h(address, now);
    if (success24h + fails === 0) return null;
    return success24h / (success24h + fails);
  }

  async recordLatency(address: string, ms: number): Promise<void> {
    const key = address.toLowerCase();
    const { rows } = await this.q().query(`SELECT ema_ms FROM host_latency WHERE host = $1`, [key]);
    const prev = rows[0]?.ema_ms != null ? Number(rows[0].ema_ms) : undefined;
    const ema = prev === undefined ? ms : LATENCY_ALPHA * ms + (1 - LATENCY_ALPHA) * prev;
    await this.q().query(
      `INSERT INTO host_latency (host, ema_ms) VALUES ($1,$2)
       ON CONFLICT (host) DO UPDATE SET ema_ms = EXCLUDED.ema_ms`,
      [key, ema],
    );
  }

  async latencyMs(address: string): Promise<number | null> {
    const { rows } = await this.q().query(`SELECT ema_ms FROM host_latency WHERE host = $1`, [address.toLowerCase()]);
    return rows[0]?.ema_ms != null ? Math.round(Number(rows[0].ema_ms)) : null;
  }
}
