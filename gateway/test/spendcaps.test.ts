import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";

let base = "";
let server: any;
const writes: any[] = [];

async function boot() {
  process.env.BUDGET_MASTER ??= "0x0000000000000000000000000000000000000000000000000000000000000001";
  const app = createApp({ requireSubscription: false,
    adminToken: "test-token",
    spendCapWriter: vi.fn(async (...args: any[]) => {
      writes.push(args);
      return "0xtxstub";
    }),
  });
  const port = await new Promise<number>((r) => {
    server = app.listen(0, () => r((server.address() as any).port));
  });
  base = `http://127.0.0.1:${port}`;
}

async function post(body: unknown, token = "test-token") {
  return await fetch(`${base}/api/admin/spend-caps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("admin spend-caps (onchain allowance mirror)", () => {
  beforeAll(boot);
  afterAll(() => server?.close());

  it("rejects without admin token", async () => {
    const r = await post({ address: "0x1111111111111111111111111111111111111111", capCredits: 100 }, "wrong");
    expect(r.status).toBe(401);
  });

  it("sets cap + period for an address", async () => {
    const r = await post({ address: "0x1111111111111111111111111111111111111111", capCredits: 500, periodDays: 30 });
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.targets).toEqual(["0x1111111111111111111111111111111111111111"]);
    expect(d.capCredits).toBe(500);
    expect(d.periodDays).toBe(30);
    expect(writes.at(-1)).toEqual(["0x1111111111111111111111111111111111111111", 500n, 30]);
  });

  it("null cap clears back to uncapped (periodDays 0)", async () => {
    const r = await post({ address: "0x1111111111111111111111111111111111111111", capCredits: null });
    expect(r.status).toBe(200);
    expect(writes.at(-1)).toEqual(["0x1111111111111111111111111111111111111111", 0n, 0]);
  });

  it("cap 0 denies all (removed members)", async () => {
    const r = await post({ address: "0x1111111111111111111111111111111111111111", capCredits: 0, periodDays: 30 });
    expect(r.status).toBe(200);
    expect(writes.at(-1)).toEqual(["0x1111111111111111111111111111111111111111", 0n, 30]);
  });

  it("prefix also caps the derived budget account", async () => {
    const r = await post({ prefix: "deadbeef01", capCredits: 100 });
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.targets.length).toBe(1);
    expect(d.targets[0]).toMatch(/^0x[0-9a-f]{40}$/);
    expect(writes.at(-1)?.[1]).toBe(100n);
  });

  it("400s on bad address / missing targets / bad period", async () => {
    expect((await post({ address: "0x123", capCredits: 1 })).status).toBe(400);
    expect((await post({ capCredits: 1 })).status).toBe(400);
    expect((await post({ address: "0x1111111111111111111111111111111111111111", capCredits: 1, periodDays: 999 })).status).toBe(400);
  });

  it("501s without a chain writer (dev / old vault)", async () => {
    const plain = createApp({ requireSubscription: false, adminToken: "t2" });
    const p2 = await new Promise<number>((r) => {
      const s2 = plain.listen(0, () => r((s2.address() as any).port));
      (global as any).__s2 = s2;
    });
    const r = await fetch(`http://127.0.0.1:${p2}/api/admin/spend-caps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t2" },
      body: JSON.stringify({ address: "0x1111111111111111111111111111111111111111", capCredits: 1 }),
    });
    expect(r.status).toBe(501);
    (global as any).__s2.close();
  });
});
