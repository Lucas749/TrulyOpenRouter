import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Server-held quorum private keys (`wallet-auth:<base64 PKCS8>`), gitignored JSON, 0600.
// Production moves these to KMS/Key Ring with identical sign-call shape (see privy-sign.ts).
// Orgs created BEFORE this store existed have no entry -> server cannot auto-approve for
// them (UI shows "import key or recreate team"); nothing is silently skipped.

function storePath(): string {
  const dir = process.env.TOR_PRIVY_KEYS_DIR ?? join(process.cwd(), ".data");
  return join(dir, "quorum-keys.json");
}

type Store = Record<string, { privateKey: string; createdAt: number }>;

function read(): Store {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8")) as Store;
  } catch {
    return {};
  }
}

function write(s: Store): void {
  const p = storePath();
  mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {}
}

export function saveQuorumKey(quorumId: string, privateKey: string): void {
  const s = read();
  s[quorumId] = { privateKey, createdAt: Date.now() };
  write(s);
}

export function getQuorumKey(quorumId: string): string | null {
  return read()[quorumId]?.privateKey ?? null;
}

export function hasQuorumKey(quorumId: string): boolean {
  return getQuorumKey(quorumId) !== null;
}

export function quorumKeyPath(): string {
  return storePath();
}

export function storeExistsForTest(): boolean {
  return existsSync(storePath());
}
