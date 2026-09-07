import { beforeEach, describe, expect, it } from "vitest";
import { db, dbEnabled, ensureSchema } from "../src/db.js";
import { buildReceipt, PgReceiptLog } from "../src/receipts.js";
import { issueKey, PgKeyStore, verifyKey } from "../src/keys.js";
import { PgCapStore } from "../src/allowances.js";
import { mintTap, PgTapStore } from "../src/taps.js";

// Postgres backend proof. Runs ONLY with DATABASE_URL set (local docker or
// RDS); skipped otherwise so unit CI stays device/db-free:
//   DATABASE_URL=postgresql://postgres:tor@127.0.0.1:5433/tor npx vitest run test/pg.test.ts
const pg = dbEnabled() ? describe : describe.skip;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

pg("postgres backends", () => {
  beforeEach(async () => {
    await ensureSchema();
    await db().query(`TRUNCATE receipts, api_keys, spend_caps, taps`);
  });

  it("receipts roundtrip + annotate", async () => {
    const log = new PgReceiptLog();
    const r = buildReceipt({ promptHash: "p", completionHash: "c", modelDigest: "m", host: "h", priceWei: "5", latencyMs: 3, user: `u-${uid()}`, amountCredits: "7" });
    await log.append(r);
    expect((await log.get(r.id))?.amountCredits).toBe("7");
    await log.annotate(r.id, { debitTx: "0xabc", amountCredits: "9" });
    const got = await log.get(r.id);
    expect(got?.debitTx).toBe("0xabc");
    expect(got?.amountCredits).toBe("9");
    expect((await log.list(10)).map((x) => x.id)).toContain(r.id);
  });

  it("keys save/find/revoke with hash check", async () => {
    const store = new PgKeyStore();
    const { key, record } = issueKey({ models: ["m"] });
    await store.save(record);
    const found = await store.find(key);
    expect(found && verifyKey(key, found)).toBe(true);
    expect(await store.revoke(record.prefix)).toBe(true);
    expect(await store.revoke(record.prefix)).toBe(true); // idempotent true (row exists, already revoked)
    expect(verifyKey(key, (await store.find(key))!)).toBe(false);
    expect(await store.find("tor_sk_nope000000")).toBeUndefined();
  });

  it("caps set/get/remove", async () => {
    const store = new PgCapStore();
    const p = `p-${uid()}`;
    expect(await store.getCap(p)).toBeNull();
    await store.setCap(p, 50, 1000);
    expect(await store.getCap(p)).toMatchObject({ cap: 50, periodStart: 1000 });
    expect(await store.removeCap(p)).toBe(true);
    expect(await store.getCap(p)).toBeNull();
    await expect(store.setCap("", 1)).rejects.toThrow("prefix required");
  });

  it("taps queue/approve/execute with mint parity", async () => {
    const store = new PgTapStore();
    const t = await store.queue("heartbeat", {});
    expect(t).toMatchObject({ status: "pending" });
    expect(t.approveMemo).toContain(t.id);
    // mintTap binds identically for both backends
    const m = mintTap("heartbeat", {});
    expect(m.approveMemo).toContain(m.id);
    await expect(store.queue("nuke", {})).rejects.toThrow("unknown tap kind");
    const ap = await store.markApproved(t.id, "0.0.1@1.0", "0.0.1");
    expect(ap).toMatchObject({ status: "approved", tapTx: "0.0.1@1.0" });
    await expect(store.markApproved(t.id, "x", "y")).rejects.toThrow("already approved");
    const done = await store.markExecuted(t.id, "0xexec");
    expect(done).toMatchObject({ status: "executed", execTx: "0xexec" });
    expect((await store.list("executed")).map((x) => x.id)).toContain(t.id);
  });
});
