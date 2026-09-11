import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decryptSecret, loadRingSecrets, PROTECTED_SECRETS, RING_MAP } from "../src/ring.js";

const stubRunner = (values: Record<string, string>) => ({
  decrypt: async (key: string, ciphertext: Buffer) => {
    expect(ciphertext.toString()).toBe(`enc-for-${key}`);
    if (!(key in values)) throw new Error(`ring decrypt ${key}: no such key`);
    return values[key];
  },
});

describe("ring broker", () => {
  it("refuses without WALLET_PASS", async () => {
    const saved = process.env.WALLET_PASS;
    delete process.env.WALLET_PASS;
    try {
      await expect(decryptSecret("tor/x", Buffer.from("blob"), stubRunner({}))).rejects.toThrow("WALLET_PASS");
    } finally {
      if (saved !== undefined) process.env.WALLET_PASS = saved;
    }
  });

  it("rejects empty plaintext", async () => {
    process.env.WALLET_PASS = "test-only";
    await expect(decryptSecret("tor/x", Buffer.from("enc-for-tor/x"), stubRunner({ "tor/x": "" }))).rejects.toThrow("empty plaintext");
    delete process.env.WALLET_PASS;
  });

  it("loads mapped secrets from .enc files, env fallback only for unprotected ones", async () => {
    process.env.WALLET_PASS = "test-only";
    const dir = mkdtempSync(join(tmpdir(), "tor-ring-"));
    try {
      writeFileSync(join(dir, "budget-master.enc"), "enc-for-tor/budget-master");
      const { loaded, fallback, unavailable } = await loadRingSecrets({
        secretsDir: dir,
        runner: stubRunner({ "tor/budget-master": "0xmaster" }),
      });
      expect(loaded).toEqual(["BUDGET_MASTER"]);
      expect(process.env.BUDGET_MASTER).toBe("0xmaster");
      expect(fallback.sort()).toEqual(Object.keys(RING_MAP).filter((k) => !PROTECTED_SECRETS.has(k)).sort());
      expect(unavailable.sort()).toEqual(["PRIVY_BROKER_AUTH_KEY", "X402_PAYER_KEY"]);
    } finally {
      delete process.env.WALLET_PASS;
      delete process.env.BUDGET_MASTER;
    }
  });

  it("never falls back to environment keys for financial secrets, even when strict", async () => {
    process.env.WALLET_PASS = "test-only";
    const dir = mkdtempSync(join(tmpdir(), "tor-ring-protected-"));
    for (const [env, key] of Object.entries(RING_MAP)) {
      if (!PROTECTED_SECRETS.has(env)) writeFileSync(join(dir, `${key.split("/")[1]}.enc`), `enc-for-${key}`);
    }
    writeFileSync(join(dir, "x402-payer.enc"), "enc-for-tor/x402-payer"); // present but not decryptable
    process.env.BUDGET_MASTER = "env-budget-master";
    process.env.X402_PAYER_KEY = "env-x402-key";
    process.env.PRIVY_BROKER_AUTH_KEY = "env-broker-key";
    const values = Object.fromEntries(Object.entries(RING_MAP).filter(([env]) => !PROTECTED_SECRETS.has(env)).map(([, key]) => [key, `ring:${key}`]));
    try {
      const { loaded, unavailable } = await loadRingSecrets({ secretsDir: dir, strict: true, runner: stubRunner(values) });
      expect(unavailable.sort()).toEqual(["BUDGET_MASTER", "PRIVY_BROKER_AUTH_KEY", "X402_PAYER_KEY"]);
      expect(loaded.sort()).toEqual(["HCS_OPERATOR_KEY", "HOST_KEY", "OPERATOR_KEY"]);
      expect(process.env.BUDGET_MASTER).toBeUndefined();
      expect(process.env.X402_PAYER_KEY).toBeUndefined();
      expect(process.env.PRIVY_BROKER_AUTH_KEY).toBeUndefined();
      expect(process.env.OPERATOR_KEY).toBe("ring:tor/vault-operator");
    } finally {
      for (const env of Object.keys(RING_MAP)) delete process.env[env];
      delete process.env.WALLET_PASS;
    }
  });

  it("strict mode throws on missing unprotected files", async () => {
    process.env.WALLET_PASS = "test-only";
    const dir = mkdtempSync(join(tmpdir(), "tor-ring-empty-"));
    try {
      await expect(loadRingSecrets({ secretsDir: dir, strict: true, runner: stubRunner({}) })).rejects.toThrow();
    } finally {
      delete process.env.WALLET_PASS;
    }
  });
});
