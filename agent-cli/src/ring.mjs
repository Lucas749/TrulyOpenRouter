import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { RING_KEY, RING_SERVICE, SEALED_KEY, fail } from "./config.mjs";

// require() so a globally installed keychain library resolves on a host too, which import() skips.
const require = createRequire(import.meta.url);

// Ledger Key Ring access. The password comes from the machine's keychain by lookup, never from an
// argument, and the agent key is decrypted into memory for one task only.

/// @notice The Key Ring password for this machine, or null. Never printed or logged.
export async function walletPass() {
  if (process.env.WALLET_PASS) return process.env.WALLET_PASS;
  if (process.platform === "darwin") {
    const out = spawnSync("security", ["find-generic-password", "-a", "default", "-s", RING_SERVICE, "-w"], { encoding: "utf8" });
    if (out.status === 0 && out.stdout.trim()) return out.stdout.trim();
    return null;
  }
  try {
    const { Entry } = require("@napi-rs/keyring");
    return new Entry(RING_SERVICE, "default").getPassword() || null;
  } catch {
    return null;
  }
}

async function ringEnv() {
  const pass = await walletPass();
  if (!pass) {
    fail(
      process.platform === "darwin"
        ? `No Key Ring password. Store it once: security add-generic-password -a default -s ${RING_SERVICE} -w`
        : `No Key Ring password in this host's keychain. Enrol this host from your Mac: tor-agent enroll --docker <name>`,
    );
  }
  return { ...process.env, WALLET_PASS: pass };
}

/// @notice Decrypt the sealed agent key into this process's memory.
export async function unsealAgentKey() {
  if (!existsSync(SEALED_KEY)) fail(`No sealed agent key at ${SEALED_KEY}. Run: tor-agent seal`);
  try {
    return execFileSync("wallet-cli", ["ring", "decrypt", "--key", RING_KEY], {
      input: readFileSync(SEALED_KEY),
      env: await ringEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString("utf8")
      .replace(/\n$/, "");
  } catch (e) {
    return fail(`Key Ring decrypt failed for ${RING_KEY}: ${String(e.stderr || e.message).slice(0, 200)}`);
  }
}

/// @notice Seal an agent key under the ring key, leaving only ciphertext on disk.
export async function sealAgentKey(key) {
  if (!/^tor_sk_agt_/.test(key.trim())) fail("That does not look like an agent key (tor_sk_agt_…).");
  const sealed = execFileSync("wallet-cli", ["ring", "encrypt", "--key", RING_KEY], { input: key.trim(), env: await ringEnv(), maxBuffer: 1 << 20 });
  mkdirSync(dirname(SEALED_KEY), { recursive: true, mode: 0o700 });
  writeFileSync(SEALED_KEY, sealed, { mode: 0o600 });
  return SEALED_KEY;
}

/// @notice This machine's Key Ring membership from the macOS keychain; macOS asks the human to allow it.
export function memberCredential(account) {
  const out = spawnSync("security", ["find-generic-password", "-s", RING_SERVICE, "-a", account, "-w"], { encoding: "utf8" });
  if (out.status !== 0 || !out.stdout.trim()) return null;
  const value = out.stdout.trim();
  // `security -w` prints this item hex-encoded; the Key Ring stores it as text, so hand the text across.
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0 ? Buffer.from(value, "hex").toString("utf8") : value;
}
