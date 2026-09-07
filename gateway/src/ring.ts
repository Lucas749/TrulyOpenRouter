import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { join } from "path";

// Ledger Key Ring secrets broker (L3: "device-backed trust").
//
// Model: CIPHERTEXT lives in the repo (gateway/secrets/<name>.enc — safe to
// commit, AES-256-GCM under a trustchain key). The KEY lives in the Ledger
// trustchain + operator password. At boot, with WALLET_PASS in the gateway's
// environment (injected once via keychain substitution, never logged), each
// mapped secret is decrypted into memory. Plaintext never touches disk.
//
// Dev fallback: when SECRETS_BACKEND != "ring" (or a .enc file is missing),
// plain env vars are used as today — local dev never needs the device.
// Production MUST run SECRETS_BACKEND=ring with all four files present.

export interface RingRunner {
  decrypt(key: string, ciphertext: Buffer): Promise<string>;
}

function cliRunner(): RingRunner {
  return {
    decrypt: (key, ciphertext) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          "wallet-cli",
          ["ring", "decrypt", "--key", key],
          { maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(`ring decrypt ${key}: ${String(stderr || err.message).slice(0, 160)}`));
            resolve(stdout.replace(/\n$/, ""));
          },
        );
        child.stdin?.end(ciphertext);
      }),
  };
}

/// @notice Decrypt one named ring key. Ciphertext comes from the caller (read
/// from gateway/secrets/<name>.enc) so this stays testable without files.
export async function decryptSecret(key: string, ciphertext: Buffer, runner: RingRunner = cliRunner()): Promise<string> {
  if (!process.env.WALLET_PASS) throw new Error("WALLET_PASS is not set — inject it at boot, never commit it");
  const value = await runner.decrypt(key, ciphertext);
  if (!value) throw new Error(`ring decrypt ${key}: empty plaintext`);
  return value;
}

export const RING_MAP: Record<string, string> = {
  BUDGET_MASTER: "tor/budget-master",
  OPERATOR_KEY: "tor/vault-operator",
  X402_PAYER_KEY: "tor/x402-payer",
  HCS_OPERATOR_KEY: "tor/hcs-operator",
  HOST_KEY: "tor/host", // demo-host key: tap-gated release/heartbeat executor only
};

/// @notice Load mapped secrets from gateway/secrets/*.enc into process.env.
/// Missing files fall back to existing env (dev); when strict, they throw.
export async function loadRingSecrets(
  opts: { secretsDir?: string; strict?: boolean; runner?: RingRunner } = {},
): Promise<{ loaded: string[]; fallback: string[] }> {
  const dir = opts.secretsDir ?? join(process.cwd(), "secrets");
  const loaded: string[] = [];
  const fallback: string[] = [];
  for (const [env, key] of Object.entries(RING_MAP)) {
    const short = key.split("/")[1] ?? key;
    try {
      const ciphertext = await readFile(join(dir, `${short}.enc`));
      process.env[env] = await decryptSecret(key, ciphertext, opts.runner);
      loaded.push(env);
    } catch (e: any) {
      if (opts.strict) throw e;
      fallback.push(env);
    }
  }
  return { loaded, fallback };
}
