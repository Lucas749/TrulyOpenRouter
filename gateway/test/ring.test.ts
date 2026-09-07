import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decryptSecret, loadRingSecrets, RING_MAP } from "../src/ring.js";

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

  it("loads mapped secrets from .enc files, env fallback otherwise", async () => {
    process.env.WALLET_PASS = "test-only";
    const dir = mkdtempSync(join(tmpdir(), "tor-ring-"));
    try {
      writeFileSync(join(dir, "budget-master.enc"), "enc-for-tor/budget-master");
      const { loaded, fallback } = await loadRingSecrets({
        secretsDir: dir,
        runner: stubRunner({ "tor/budget-master": "0xmaster" }),
      });
      expect(loaded).toEqual(["BUDGET_MASTER"]);
      expect(process.env.BUDGET_MASTER).toBe("0xmaster");
      expect(fallback.sort()).toEqual(Object.keys(RING_MAP).filter((k) => k !== "BUDGET_MASTER").sort());
    } finally {
      delete process.env.WALLET_PASS;
      delete process.env.BUDGET_MASTER;
    }
  });

  it("strict mode throws on missing files", async () => {
    process.env.WALLET_PASS = "test-only";
    const dir = mkdtempSync(join(tmpdir(), "tor-ring-empty-"));
    try {
      await expect(loadRingSecrets({ secretsDir: dir, strict: true, runner: stubRunner({}) })).rejects.toThrow();
    } finally {
      delete process.env.WALLET_PASS;
    }
  });
});
