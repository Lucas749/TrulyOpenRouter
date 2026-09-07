import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "./db.js";

export interface KeyScopes {
  models?: string[]; // default: all
  spendCap?: number; // credits, default: unlimited (user quota still applies)
  expiresAt?: number; // unix ms, default: never
  ratePerMin?: number; // default: unlimited
}

export interface ApiKeyRecord {
  id: string;
  prefix: string;
  hash: string;
  salt: string;
  scopes: KeyScopes;
  createdAt: number;
  revoked: boolean;
}

export interface IssuedKey {
  key: string; // tor_sk_… — shown ONCE, never stored
  record: ApiKeyRecord;
}

export function issueKey(scopes: KeyScopes = {}): IssuedKey {
  const key = `tor_sk_${randomBytes(24).toString("base64url")}`;
  const salt = randomBytes(16).toString("hex");
  return {
    key,
    record: {
      id: randomBytes(8).toString("hex"),
      prefix: key.slice(0, 12),
      hash: hashKey(key, salt),
      salt,
      scopes,
      createdAt: Date.now(),
      revoked: false,
    },
  };
}

export function hashKey(key: string, salt: string): string {
  return createHash("sha256").update(salt + key).digest("hex");
}

export function verifyKey(key: string, record: ApiKeyRecord, now = Date.now()): boolean {
  if (record.revoked) return false;
  if (record.scopes.expiresAt !== undefined && now > record.scopes.expiresAt) return false;
  const a = Buffer.from(hashKey(key, record.salt), "hex");
  const b = Buffer.from(record.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface KeyStore {
  save(record: ApiKeyRecord): Promise<void>;
  find(key: string): Promise<ApiKeyRecord | undefined>;
  revoke(prefix: string): Promise<boolean>;
}

/// @notice In-memory store (dev + tests). Same interface as PgKeyStore.
export class MemoryKeyStore implements KeyStore {
  private byPrefix = new Map<string, ApiKeyRecord>();

  async save(record: ApiKeyRecord): Promise<void> {
    this.byPrefix.set(record.prefix, record);
  }

  async find(key: string): Promise<ApiKeyRecord | undefined> {
    return this.byPrefix.get(key.slice(0, 12));
  }

  async revoke(prefix: string): Promise<boolean> {
    const r = this.byPrefix.get(prefix);
    if (!r) return false;
    r.revoked = true;
    return true;
  }
}

function rowToRecord(row: any): ApiKeyRecord {
  return {
    id: String(row.id ?? ""),
    prefix: row.prefix,
    hash: row.key_hash,
    salt: "", // salt is folded into the stored hash input; find() returns the record for verifyKey
    scopes: typeof row.scopes === "string" ? JSON.parse(row.scopes) : (row.scopes ?? {}),
    createdAt: Number(row.created_at),
    revoked: !!row.revoked,
  };
}

/// @notice Postgres store (DATABASE_URL set). Plaintext keys never stored —
/// only prefix + salted hash, exactly like memory.
export class PgKeyStore implements KeyStore {
  constructor(private pool?: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) {}

  private q() {
    return this.pool ?? db();
  }

  async save(record: ApiKeyRecord): Promise<void> {
    await this.q().query(
      `INSERT INTO api_keys (prefix, key_hash, created_at, expires_at, scopes, revoked)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (prefix) DO UPDATE SET revoked = EXCLUDED.revoked, scopes = EXCLUDED.scopes`,
      [record.prefix, `${record.salt}:${record.hash}`, record.createdAt, record.scopes.expiresAt ?? null, JSON.stringify(record.scopes), record.revoked],
    );
  }

  async find(key: string): Promise<ApiKeyRecord | undefined> {
    const { rows } = await this.q().query(`SELECT * FROM api_keys WHERE prefix = $1`, [key.slice(0, 12)]);
    if (!rows[0]) return undefined;
    const rec = rowToRecord(rows[0]);
    const [salt, hash] = String(rows[0].key_hash).split(":");
    rec.salt = salt ?? "";
    rec.hash = hash ?? "";
    return rec;
  }

  async revoke(prefix: string): Promise<boolean> {
    const { rows } = await this.q().query(`UPDATE api_keys SET revoked = true WHERE prefix = $1 RETURNING prefix`, [prefix]);
    return rows.length > 0;
  }
}
