import { beforeEach, describe, expect, it } from "vitest";
import { db, dbEnabled, ensureSchema } from "../src/db.js";
import { buildReceipt, PgReceiptLog } from "../src/receipts.js";
import { issueKey, PgKeyStore, verifyKey } from "../src/keys.js";
import { PgCapStore } from "../src/allowances.js";
import { mintTap, PgTapStore } from "../src/taps.js";
import { PgOrgRules } from "../src/orgrules.js";
import { PgDeviceFlow } from "../src/device.js";
import { PgHealth } from "../src/health.js";
import { PgHostMeta } from "../src/hostmeta.js";
import { PgVerifier } from "../src/verify.js";

// Postgres backend proof. Runs ONLY with DATABASE_URL set (local docker or
// RDS); skipped otherwise so unit CI stays device/db-free:
//   DATABASE_URL=postgresql://postgres:tor@127.0.0.1:5433/tor npx vitest run test/pg.test.ts
const pg = dbEnabled() ? describe : describe.skip;
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

pg("postgres backends", () => {
  beforeEach(async () => {
    await ensureSchema();
    await db().query(`TRUNCATE receipts, api_keys, spend_caps, taps, host_meta, device_codes, verify_reports, host_fails, host_latency, org_rules`);
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

  it("host meta regions + owner claims survive", async () => {
    const meta = new PgHostMeta();
    const a = `0xabc${uid()}`.slice(0, 42);
    await meta.setRegion(a, "eu-central");
    await meta.setOwner(a, "user-7");
    expect(await meta.regionOf(a.toUpperCase())).toBe("eu-central");
    expect(await meta.distinctRegions()).toEqual(["eu-central"]);
    expect(await meta.ownerOf(a)).toBe("user-7");
    expect(await meta.hostsOf("user-7")).toEqual([a.toLowerCase()]);
  });

  it("device codes issue/approve/poll", async () => {
    const f = new PgDeviceFlow();
    const { code } = await f.issue();
    expect(await f.poll(code)).toMatchObject({ status: "pending" });
    const ok = await f.approve(code.toLowerCase(), "user-9");
    expect(ok?.token.startsWith("tor_dev_")).toBe(true);
    expect(await f.poll(code)).toMatchObject({ status: "approved", userId: "user-9" });
    expect(await f.approve("NOPE12", "u")).toBeNull();
  });

  it("verifier keeps failing streaks", async () => {
    const v = new PgVerifier();
    const host = `0xfeed${uid()}`.slice(0, 42);
    expect((await v.verification(host)).failing).toBe(false);
    for (let i = 0; i < 3; i++) {
      await v.record({ host, modelId: "m", ts: 1000 + i, passed: 0, total: 5, score: 0, inconclusive: false, results: [] });
    }
    const s = await v.verification(host);
    expect(s.checks).toBe(3);
    expect(s.failing).toBe(true);
    expect(await v.scoreMultiplier(host)).toBe(0);
  });

  it("health fails + EMA roundtrip", async () => {
    const h = new PgHealth();
    const host = `0xbeef${uid()}`.slice(0, 42);
    expect(await h.latencyMs(host)).toBeNull();
    await h.recordFail(host, 1000);
    await h.recordFail(host, 2000);
    expect(await h.fails24h(host, 3000)).toBe(2);
    expect(await h.reliability(8, host, 3000)).toBe(0.8);
    await h.recordLatency(host, 100);
    await h.recordLatency(host, 200);
    expect(await h.latencyMs(host)).toBe(130);
  });

  it("org rules roundtrip + handle match", async () => {
    const s = new PgOrgRules();
    expect(await s.get("oxyz")).toBeNull();
    await s.set({ orgId: "oxyz", dailyCapCredits: 42, allowedModels: ["m1"], handles: ["key:abc"] });
    expect(await s.get("oxyz")).toMatchObject({ dailyCapCredits: 42 });
    expect(await s.orgsForHandle("key:abc")).toHaveLength(1);
    expect(await s.orgsForHandle("key:nope")).toHaveLength(0);
    await expect(s.set({ orgId: "", dailyCapCredits: null, allowedModels: null, handles: [] })).rejects.toThrow("orgId required");
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
