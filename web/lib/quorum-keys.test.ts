import { describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { db, dbEnabled, ensureSchema } from "../lib/db";
import { getQuorumKey, hasQuorumKey, saveQuorumKey } from "../lib/quorum-keys";

(process.env.DATABASE_URL ? describe : describe.skip)("quorum-keys on postgres", () => {
  it("roundtrips server keys", async () => {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    const id = `q-${Date.now().toString(36)}`;
    await db().query(`DELETE FROM quorum_keys WHERE quorum_id = $1`, [id]);
    expect(await getQuorumKey(id)).toBeNull();
    await saveQuorumKey(id, "wallet-auth:pgtest");
    expect(await getQuorumKey(id)).toBe("wallet-auth:pgtest");
    expect(await hasQuorumKey(id)).toBe(true);
    await db().query(`DELETE FROM quorum_keys WHERE quorum_id = $1`, [id]);
  });
});

describe("quorum-keys store", () => {
  it("roundtrips keys, misses cleanly", async () => {
    process.env.TOR_PRIVY_KEYS_DIR = mkdtempSync(join(tmpdir(), "tor-qk-"));
    delete process.env.DATABASE_URL;
    expect(await hasQuorumKey("q1")).toBe(false);
    expect(await getQuorumKey("q1")).toBeNull();
    await saveQuorumKey("q1", "wallet-auth:abc123");
    expect(await hasQuorumKey("q1")).toBe(true);
    expect(await getQuorumKey("q1")).toBe("wallet-auth:abc123");
    delete process.env.TOR_PRIVY_KEYS_DIR;
  });
});
