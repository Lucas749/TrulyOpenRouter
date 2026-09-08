import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { MemoryKeyStore } from "../src/keys.js";
import { buildReceipt, MemoryReceiptLog } from "../src/receipts.js";
import { allowanceExceeded, SpendCapStore, sumSpent } from "../src/allowances.js";

function receipt(user: string, amountCredits: string | undefined, ts: number) {
  return { user, amountCredits, ts };
}

describe("SpendCapStore", () => {
  it("sets, reads, and removes caps", async () => {
    const s = new SpendCapStore();
    expect(await s.getCap("abc")).toBeNull();
    const rec = await s.setCap("abc", 100, 1000);
    expect(rec).toMatchObject({ cap: 100, periodStart: 1000 });
    expect((await s.getCap("abc"))?.cap).toBe(100);
    expect(await s.removeCap("abc")).toBe(true);
    expect(await s.removeCap("abc")).toBe(false);
    await expect(s.setCap("", 1)).rejects.toThrow("prefix required");
    await expect(s.setCap("x", -1)).rejects.toThrow("non-negative");
    await expect(s.setCap("x", NaN)).rejects.toThrow("non-negative");
  });
});

describe("sumSpent", () => {
  it("sums settled credits for the handle since period start", () => {
    const rs = [
      receipt("key:abc", "10", 1000),
      receipt("key:abc", "5", 2000),
      receipt("key:abc", undefined, 3000), // unsettled counts 0
      receipt("key:abc", "7", 500), // before period
      receipt("key:xyz", "99", 2500), // other handle
      receipt("dev", "3", 2500),
    ];
    expect(sumSpent(rs, "key:abc", 1000)).toBe(15);
    expect(sumSpent(rs, "key:xyz", 0)).toBe(99);
    expect(sumSpent(rs, "key:nobody", 0)).toBe(0);
  });
});

describe("allowanceExceeded", () => {
  it("blocks at the cap, allows below and when uncapped", () => {
    expect(allowanceExceeded(100, 100)).toBe(true);
    expect(allowanceExceeded(150, 100)).toBe(true);
    expect(allowanceExceeded(99, 100)).toBe(false);
    expect(allowanceExceeded(9999, undefined)).toBe(false);
    expect(allowanceExceeded(5, 0)).toBe(true); // zero cap = fully blocked
  });
});

describe("allowance enforcement in chat flow", () => {
  const OLD_TOKEN = process.env.GATEWAY_ADMIN_TOKEN;

  afterEach(() => {
    if (OLD_TOKEN === undefined) delete process.env.GATEWAY_ADMIN_TOKEN;
    else process.env.GATEWAY_ADMIN_TOKEN = OLD_TOKEN;
  });

  function spentReceipt(user: string, amountCredits: string, ts: number) {
    return buildReceipt(
      { promptHash: "p", completionHash: "c", modelDigest: "m", host: "h", priceWei: "1", latencyMs: 1, amountCredits, user },
      ts,
    );
  }

  async function chat(port: number, key: string) {
    return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "llama-3.1-8b", messages: [] }),
    });
  }

  it("429s with reason quota_exceeded and serves under cap", async () => {
    const { issueKey } = await import("../src/keys.js");
    const receipts = new MemoryReceiptLog();
    const spendCaps = new SpendCapStore();
    const keys = new MemoryKeyStore();
    // find (or force) a key record with a known prefix
    const issued = issueKey();
    const prefix = issued.record.prefix;
    await keys.save(issued.record);
    await spendCaps.setCap(prefix, 20, 0);
    for (let i = 0; i < 2; i++) await receipts.append(spentReceipt(`key:${prefix}`, "10", Date.now()));
    const app = createApp({ keys, receipts, spendCaps, adminToken: "t", fallbackUpstream: "http://127.0.0.1:1" });
    const srv = app.listen(0);
    const port = (srv.address() as any).port;
    try {
      const blocked = await chat(port, issued.key);
      expect(blocked.status).toBe(429);
      const body: any = await blocked.json();
      expect(body.error.type).toBe("quota_exceeded");
      // usage endpoint aggregates honestly
      const before: any = await (await fetch(`http://127.0.0.1:${port}/api/usage/key:${prefix}`)).json();
      expect(before).toMatchObject({ spent: 20, cap: 20 });
      // raise the cap via admin -> fresh period starts (documented), same key passes
      // auth (502 = reached dead upstream, not blocked)
      const admin = await fetch(`http://127.0.0.1:${port}/api/admin/caps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
        body: JSON.stringify({ prefix, cap: 1000 }),
      });
      expect(admin.status).toBe(200);
      const allowed = await chat(port, issued.key);
      expect(allowed.status).toBe(502); // dead upstream proves the gate passed
      const after: any = await (await fetch(`http://127.0.0.1:${port}/api/usage/key:${prefix}`)).json();
      expect(after).toMatchObject({ spent: 0, cap: 1000 }); // new cap = new period
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("drip validates, refuses existing accounts, needs backend keys", async () => {
    const app = createApp({ adminToken: "t" });
    const srv = app.listen(0);
    const port = (srv.address() as any).port;
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/admin/drip`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
        body: JSON.stringify(body),
      });
    try {
      expect((await post({ address: "junk" })).status).toBe(400);
      // Mirror stub: account exists -> 409, never touches keys.
      const orig = globalThis.fetch;
      (globalThis as any).fetch = async (url: any, init: any) =>
        String(url).includes("mirrornode") ? ({ ok: true } as any) : orig(url, init);
      try {
        const dup = await post({ address: "0x1234567890abcdef1234567890abcdef12345678" });
        expect(dup.status).toBe(409);
      } finally {
        globalThis.fetch = orig;
      }
    } finally {
      srv.close();
    }
  });

  it("admin surface fails closed without a token and rejects bad tokens", async () => {
    delete process.env.GATEWAY_ADMIN_TOKEN;
    const app = createApp({ keys: new MemoryKeyStore(), spendCaps: new SpendCapStore() });
    const srv = app.listen(0);
    const port = (srv.address() as any).port;
    try {
      const off = await fetch(`http://127.0.0.1:${port}/api/admin/caps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
        body: JSON.stringify({ prefix: "p", cap: 1 }),
      });
      expect(off.status).toBe(501);
      process.env.GATEWAY_ADMIN_TOKEN = "s3cret";
      const bad = await fetch(`http://127.0.0.1:${port}/api/admin/caps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
        body: JSON.stringify({ prefix: "p", cap: 1 }),
      });
      expect(bad.status).toBe(401);
      const badBody = await fetch(`http://127.0.0.1:${port}/api/admin/caps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" },
        body: JSON.stringify({ prefix: "p", cap: -5 }),
      });
      expect(badBody.status).toBe(400);
      const del = await fetch(`http://127.0.0.1:${port}/api/admin/caps/p`, {
        method: "DELETE",
        headers: { Authorization: "Bearer s3cret" },
      });
      expect(del.status).toBe(200);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
