import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { MemoryKeyStore, PgKeyStore, issueKey, verifyKey } from "../src/keys.js";

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

  it("records the login that issued a key", () => {
    expect(issueKey({}, "did:privy:owner").record.ownerUserId).toBe("did:privy:owner");
    expect(issueKey().record.ownerUserId).toBeNull();
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("durable api keys", () => {
  const pool = new Pool({ connectionString: database });
  const store = new PgKeyStore(pool);
  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => {
    await pool.end();
  });

  it("keeps the issuing login, even when the same prefix is saved again", async () => {
    const owned = issueKey({}, "did:privy:owner");
    const legacy = issueKey();
    try {
      await store.save(owned.record);
      expect((await store.find(owned.key))?.ownerUserId).toBe("did:privy:owner");
      await store.save({ ...owned.record, ownerUserId: "did:privy:attacker", revoked: true });
      expect(await store.find(owned.key)).toMatchObject({ ownerUserId: "did:privy:owner", revoked: true });
      await store.save(legacy.record);
      expect((await store.find(legacy.key))?.ownerUserId).toBeNull();
    } finally {
      await pool.query(`DELETE FROM api_keys WHERE prefix = ANY($1)`, [[owned.record.prefix, legacy.record.prefix]]);
    }
  });
});
