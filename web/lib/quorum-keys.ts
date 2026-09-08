import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { db, dbEnabled, ensureSchema } from "./db";

// Server-held quorum private keys (`wallet-auth:<base64 PKCS8>`).
// Postgres when DATABASE_URL is set (Vercel/RDS — the filesystem is read-only
// there, so file mode hard-crashes team creation), else gitignored JSON 0600.
// Orgs created BEFORE any store existed have no entry -> server cannot
// auto-approve for them (UI shows "import key or recreate team").

type Store = Record<string, { privateKey: string; createdAt: number }>;

interface KeyBackend {
  load(): Promise<Store>;
  save(s: Store): Promise<void>;
}

function storePath(): string {
  const dir = process.env.TOR_PRIVY_KEYS_DIR ?? join(process.cwd(), ".data");
  return join(dir, "quorum-keys.json");
}

const fileBackend: KeyBackend = {
  async load(): Promise<Store> {
    try {
      return JSON.parse(readFileSync(storePath(), "utf8")) as Store;
    } catch {
      return {};
    }
  },
  async save(s: Store): Promise<void> {
    const p = storePath();
    mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {}
  },
};

const pgBackend: KeyBackend = {
  async load(): Promise<Store> {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    const { rows } = await db().query(`SELECT quorum_id, private_key, created_at FROM quorum_keys`);
    return Object.fromEntries(
      rows.map((r) => [r.quorum_id, { privateKey: r.private_key, createdAt: Number(r.created_at) }]),
    );
  },
  async save(s: Store): Promise<void> {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    for (const [id, v] of Object.entries(s)) {
      await db().query(
        `INSERT INTO quorum_keys (quorum_id, private_key, created_at) VALUES ($1,$2,$3)
         ON CONFLICT (quorum_id) DO UPDATE SET private_key = EXCLUDED.private_key`,
        [id, v.privateKey, v.createdAt],
      );
    }
  },
};

function backend(): KeyBackend {
  return dbEnabled() ? pgBackend : fileBackend;
}

export async function saveQuorumKey(quorumId: string, privateKey: string): Promise<void> {
  const s = await backend().load();
  s[quorumId] = { privateKey, createdAt: Date.now() };
  await backend().save(s);
}

export async function getQuorumKey(quorumId: string): Promise<string | null> {
  return (await backend().load())[quorumId]?.privateKey ?? null;
}

export async function hasQuorumKey(quorumId: string): Promise<boolean> {
  return (await getQuorumKey(quorumId)) !== null;
}

export function quorumKeyPath(): string {
  return storePath();
}

export function storeExistsForTest(): boolean {
  return existsSync(storePath());
}
