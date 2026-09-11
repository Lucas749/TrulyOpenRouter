import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { PgAccounting, periods, type CounterLimit } from "../src/accounting.js";

describe("accounting periods", () => {
  it("uses UTC day, UTC calendar month, and lifetime keys", () => {
    expect(periods(Date.UTC(2026, 8, 11, 23, 59))).toEqual({ day: "d:2026-09-11", month: "m:2026-09", all: "all" });
    expect(periods(Date.UTC(2026, 9, 1, 0, 0)).month).toBe("m:2026-10");
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("durable usage reservations", () => {
  const pool = new Pool({ connectionString: database, max: 12 });
  const accounting = new PgAccounting(pool);
  const agentDay = (limit: number | null, extra = 0): CounterLimit => ({ subject: "agent:test-a", period: "d:2026-09-11", limit, extra, label: "agent daily credits", approvable: true });
  const memberMonth = (limit: number | null): CounterLimit => ({ subject: "member:test-org:did:m", period: "m:2026-09", limit, label: "member monthly allowance", approvable: true });
  const reserve = (requestId: string, maximumCredits: number, counters: CounterLimit[]) =>
    accounting.reserve({ requestId, payer: "0xTEAM", agentId: "test-a", orgId: "test-org", memberDid: "did:m", maximumCredits, counters });

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM usage_counters WHERE subject LIKE '%test-%'`);
    await pool.query(`DELETE FROM usage_reservations WHERE request_id LIKE 'test-%'`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("reserves on every counter or on none, and reports each violated limit", async () => {
    expect(await reserve("test-1", 60, [agentDay(100), memberMonth(1000)])).toEqual({ ok: true });
    const denied = await reserve("test-2", 50, [agentDay(100), memberMonth(1000)]);
    expect(denied).toEqual({ ok: false, violations: [{ subject: "agent:test-a", period: "d:2026-09-11", label: "agent daily credits", limit: 100, spent: 0, reserved: 60, needed: 10, approvable: true }] });
    // Nothing was reserved on the member counter for the refused request.
    expect(await accounting.usage([{ subject: "member:test-org:did:m", period: "m:2026-09" }])).toEqual([{ subject: "member:test-org:did:m", period: "m:2026-09", spent: 0, reserved: 60 }]);
    expect(await accounting.reservation("test-2")).toBeNull();
  });

  it("settles actual usage, frees released reservations, and keeps unresolved ones", async () => {
    await reserve("test-settle", 40, [agentDay(100)]);
    await reserve("test-release", 30, [agentDay(100)]);
    await reserve("test-uncertain", 20, [agentDay(100)]);
    expect(await accounting.settle("test-settle", 7)).toMatchObject({ state: "consumed", actualCredits: 7 });
    expect(await accounting.release("test-release")).toMatchObject({ state: "released" });
    expect(await accounting.markUncertain("test-uncertain")).toMatchObject({ state: "uncertain" });
    expect(await accounting.release("test-uncertain")).toBeNull(); // unresolved payments are never released without reconciliation
    expect(await accounting.settle("test-settle", 7)).toBeNull(); // settlement applies once
    expect((await accounting.usage([{ subject: "agent:test-a", period: "d:2026-09-11" }]))[0]).toMatchObject({ spent: 7, reserved: 20 });
    expect(await accounting.openReservations("test-a")).toBe(1);
    expect(await accounting.resolveUncertain("test-uncertain", { settledCredits: 3 })).toMatchObject({ state: "consumed", actualCredits: 3 });
    expect((await accounting.usage([{ subject: "agent:test-a", period: "d:2026-09-11" }]))[0]).toMatchObject({ spent: 10, reserved: 0 });
  });

  it("never admits more than the limit under concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => reserve(`test-race-${i}`, 30, [agentDay(100), memberMonth(null)])));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await accounting.usage([{ subject: "agent:test-a", period: "d:2026-09-11" }]))[0].reserved).toBe(90);
  });

  it("applies approved extra headroom only to its own counter", async () => {
    await pool.query(`INSERT INTO usage_counters (subject, period, spent) VALUES ('agent:test-a', 'd:2026-09-11', 98), ('member:test-org:did:m', 'm:2026-09', 998)`);
    const needsBoth = await reserve("test-grant-1", 5, [agentDay(100, 3), memberMonth(1000)]);
    expect(needsBoth.ok).toBe(false);
    expect((needsBoth as any).violations.map((v: any) => v.subject)).toEqual(["member:test-org:did:m"]);
    expect(await reserve("test-grant-2", 5, [agentDay(100, 3), { ...memberMonth(1000), extra: 3 }])).toEqual({ ok: true });
  });
});
