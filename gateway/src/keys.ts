import { createHash, randomBytes, timingSafeEqual } from "crypto";

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

/// @notice In-memory store. Swap for DB when the web app lands (same interface).
export class MemoryKeyStore {
  private byPrefix = new Map<string, ApiKeyRecord>();

  save(record: ApiKeyRecord): void {
    this.byPrefix.set(record.prefix, record);
  }

  find(key: string): ApiKeyRecord | undefined {
    return this.byPrefix.get(key.slice(0, 12));
  }

  revoke(prefix: string): boolean {
    const r = this.byPrefix.get(prefix);
    if (!r) return false;
    r.revoked = true;
    return true;
  }
}
