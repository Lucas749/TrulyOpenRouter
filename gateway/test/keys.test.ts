import { describe, expect, it } from "vitest";
import { MemoryKeyStore, issueKey, verifyKey } from "../src/keys.js";

describe("api keys", () => {
  it("issues verifiable keys, rejects wrong ones", () => {
    const { key, record } = issueKey({ models: ["llama-3.1-8b"] });
    expect(key.startsWith("tor_sk_")).toBe(true);
    expect(verifyKey(key, record)).toBe(true);
    expect(verifyKey(key + "x", record)).toBe(false);
  });

  it("rejects revoked and expired keys", async () => {
    const store = new MemoryKeyStore();
    const { key, record } = issueKey();
    await store.save(record);
    expect(verifyKey(key, (await store.find(key))!)).toBe(true);
    expect(await store.revoke(record.prefix)).toBe(true);
    expect(verifyKey(key, (await store.find(key))!)).toBe(false);

    const exp = issueKey({ expiresAt: Date.now() - 1 });
    expect(verifyKey(exp.key, exp.record)).toBe(false);
  });
});
