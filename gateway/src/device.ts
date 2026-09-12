import { randomBytes } from "crypto";
import { db } from "./db.js";

// Device-code login for the host CLI: `tor-host login` shows a code, the user approves it
// on the web (Privy-authenticated), the CLI polls until approved, then stores the token.
// v1: codes are short-lived randoms; approval binds a userId. Production adds rate limits
// + signature-bound tokens.

const CODE_TTL_MS = 10 * 60_000;

export type DeviceStatus = "pending" | "approved" | "expired" | "unknown";

interface DeviceCode {
  code: string;
  userId: string | null;
  token: string | null;
  expiresAt: number;
}

function newCode(existing: Set<string>): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no confusables
  for (;;) {
    let code = "";
    const buf = randomBytes(6);
    for (const b of buf) code += alphabet[b % alphabet.length];
    if (!existing.has(code)) return code;
  }
}

export interface DeviceFlow {
  issue(): Promise<{ code: string; expiresAt: number }>;
  approve(code: string, userId: string): Promise<{ token: string } | null>;
  poll(code: string): Promise<{ status: DeviceStatus; userId?: string; token?: string }>;
}

export class MemoryDeviceFlow implements DeviceFlow {
  private codes = new Map<string, DeviceCode>();

  async issue(): Promise<{ code: string; expiresAt: number }> {
    this.prune();
    const code = newCode(new Set(this.codes.keys()));
    const rec: DeviceCode = { code, userId: null, token: null, expiresAt: Date.now() + CODE_TTL_MS };
    this.codes.set(code, rec);
    return { code, expiresAt: rec.expiresAt };
  }

  async approve(code: string, userId: string): Promise<{ token: string } | null> {
    const rec = this.codes.get(code.toUpperCase());
    if (!rec || rec.expiresAt < Date.now()) return null;
    if (!userId || userId.length > 128) return null;
    rec.userId = userId;
    rec.token = `tor_dev_${randomBytes(18).toString("base64url")}`;
    return { token: rec.token };
  }

  async poll(code: string): Promise<{ status: DeviceStatus; userId?: string; token?: string }> {
    const rec = this.codes.get(code.toUpperCase());
    if (!rec) return { status: "unknown" };
    if (rec.expiresAt < Date.now()) {
      this.codes.delete(code.toUpperCase());
      return { status: "expired" };
    }
    if (rec.token && rec.userId) return { status: "approved", userId: rec.userId, token: rec.token };
    return { status: "pending" };
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }
}

/// @notice Postgres device codes (DATABASE_URL set). A restart mid-login no
/// longer orphans the CLI poll. Expired rows pruned lazily on read.
export class PgDeviceFlow implements DeviceFlow {
  constructor(private pool?: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) {}

  private q() {
    return this.pool ?? db();
  }

  async issue(): Promise<{ code: string; expiresAt: number }> {
    await this.q().query(`DELETE FROM device_codes WHERE expires_at < $1`, [Date.now()]);
    for (;;) {
      const { rows } = await this.q().query(`SELECT code FROM device_codes`);
      const code = newCode(new Set(rows.map((r) => r.code)));
      const expiresAt = Date.now() + CODE_TTL_MS;
      const ins = await this.q().query(
        `INSERT INTO device_codes (code, expires_at) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING RETURNING code`,
        [code, expiresAt],
      );
      if (ins.rows.length) return { code, expiresAt };
    }
  }

  async approve(code: string, userId: string): Promise<{ token: string } | null> {
    if (!userId || userId.length > 128) return null;
    const token = `tor_dev_${randomBytes(18).toString("base64url")}`;
    const { rows } = await this.q().query(
      `UPDATE device_codes SET user_id = $2, token = $3
       WHERE code = $1 AND expires_at >= $4 RETURNING token`,
      [code.toUpperCase(), userId, token, Date.now()],
    );
    return rows[0] ? { token: rows[0].token } : null;
  }

  async poll(code: string): Promise<{ status: DeviceStatus; userId?: string; token?: string }> {
    const { rows } = await this.q().query(`SELECT user_id, token, expires_at FROM device_codes WHERE code = $1`, [
      code.toUpperCase(),
    ]);
    const rec = rows[0];
    if (!rec) return { status: "unknown" };
    if (Number(rec.expires_at) < Date.now()) {
      await this.q().query(`DELETE FROM device_codes WHERE code = $1`, [code.toUpperCase()]);
      return { status: "expired" };
    }
    if (rec.token && rec.user_id) return { status: "approved", userId: rec.user_id, token: rec.token };
    return { status: "pending" };
  }
}
