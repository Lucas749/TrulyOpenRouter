import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface TorConfig {
  gateway: string;
  token: string | null;
  userId: string | null;
  hostKey?: string; // hex ECDSA — chmod 0600, testnet only for now
  hostAddress?: string;
}

export function configDir(): string {
  return process.env.TOR_HOME ?? join(homedir(), ".tor");
}

export function loadConfig(): TorConfig {
  try {
    return { gateway: "", token: null, userId: null, ...JSON.parse(readFileSync(join(configDir(), "config.json"), "utf8")) };
  } catch {
    return { gateway: "", token: null, userId: null };
  }
}

export function saveConfig(cfg: TorConfig): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir(), "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function validCode(input: string): boolean {
  // Matches the gateway alphabet exactly (no 0/1/O/I confusables) — typos fail fast locally.
  return /^[A-HJ-KM-NP-Z2-9]{6}$/.test(input.trim().toUpperCase());
}
