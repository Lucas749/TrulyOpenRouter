import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { db, dbEnabled, ensureSchema } from "./db";

// Display names for UI only (headers, member labels). Client-claimed wallet
// identity — fine for your own label, never authorization. Receipts stay
// hash-anonymous regardless (privacy design, not a missing feature).

export interface UserProfile {
  wallet: string;
  displayName: string;
  updatedAt: number;
}

interface ProfileFile {
  profiles: Record<string, UserProfile>;
}

interface ProfileBackend {
  load(wallet: string): Promise<UserProfile | null>;
  save(p: UserProfile): Promise<void>;
}

function storePath(): string {
  const dir = process.env.TOR_MEMBERS_DIR ?? join(process.cwd(), ".data");
  return join(dir, "profiles.json");
}

const fileBackend: ProfileBackend = {
  async load(wallet: string): Promise<UserProfile | null> {
    try {
      const raw = JSON.parse(readFileSync(storePath(), "utf8")) as ProfileFile;
      return raw.profiles?.[wallet.toLowerCase()] ?? null;
    } catch {
      return null;
    }
  },
  async save(p: UserProfile): Promise<void> {
    let all: ProfileFile = { profiles: {} };
    try {
      all = JSON.parse(readFileSync(storePath(), "utf8")) as ProfileFile;
    } catch {}
    all.profiles = all.profiles ?? {};
    all.profiles[p.wallet.toLowerCase()] = p;
    const fp = storePath();
    mkdirSync(join(fp, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(fp, JSON.stringify(all, null, 2), { mode: 0o600 });
    try {
      chmodSync(fp, 0o600);
    } catch {}
  },
};

const pgBackend: ProfileBackend = {
  async load(wallet: string): Promise<UserProfile | null> {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    const { rows } = await db().query(`SELECT wallet, display_name, updated_at FROM user_profiles WHERE wallet = $1`, [
      wallet.toLowerCase(),
    ]);
    if (!rows[0]) return null;
    return { wallet: rows[0].wallet, displayName: rows[0].display_name, updatedAt: Number(rows[0].updated_at) };
  },
  async save(p: UserProfile): Promise<void> {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    await db().query(
      `INSERT INTO user_profiles (wallet, display_name, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (wallet) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at`,
      [p.wallet.toLowerCase(), p.displayName, p.updatedAt],
    );
  },
};

function backend(): ProfileBackend {
  return dbEnabled() ? pgBackend : fileBackend;
}

export async function getProfile(wallet: string): Promise<UserProfile | null> {
  if (!wallet) return null;
  return backend().load(wallet);
}

export async function saveProfile(wallet: string, displayName: string): Promise<UserProfile> {
  const p: UserProfile = { wallet: wallet.toLowerCase(), displayName: displayName.trim().slice(0, 60), updatedAt: Date.now() };
  await backend().save(p);
  return p;
}
