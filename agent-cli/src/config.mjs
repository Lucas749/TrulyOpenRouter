import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { err } from "./ui.mjs";

// Shared settings for tor-agent. Nothing here is secret: the agent key lives sealed in the Ledger
// Key Ring, and its plaintext only ever exists in the memory of the process doing one task.

export const BASE = (process.env.TOR_BASE ?? "https://trulyopenrouter.vercel.app/api/gw").replace(/\/+$/, "");
export const CONFIG_DIR = process.env.TOR_AGENT_HOME ?? join(homedir(), ".config", "trulyopenrouter");
export const SEALED_KEY = process.env.TOR_AGENT_KEY_ENC ?? join(CONFIG_DIR, "agent-key.enc");
export const RING_KEY = process.env.TOR_AGENT_KEY_RING ?? "tor/agent";
export const RING_SERVICE = "ledger-wallet-cli";
export const MODEL = process.env.MODEL ?? "qwen2.5:0.5b";
export const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 256);

/// @notice Where Ledger's CLI keeps its Key Ring state for a home directory.
export const ringStateDir = (home) => join(home, ".local", "state", "ledger-wallet-cli");

/// @notice The keychain account a machine looks up: Ledger's CLI names it after its state path.
export const memberAccount = (stateDir) => `member-private-key-${createHash("sha256").update(stateDir).digest("hex").slice(0, 16)}`;

export const say = (text) => process.stderr.write(`${text}\n`);
export const fail = (text) => {
  process.stderr.write(`${err(text)}\n`);
  process.exit(1);
};
