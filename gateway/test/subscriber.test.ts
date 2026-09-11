import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type GatewayOptions } from "../src/index.js";
import { issueKey, MemoryKeyStore } from "../src/keys.js";
import { MemoryReceiptLog } from "../src/receipts.js";
import { SubscriberError, subscriberWallet } from "../src/subscriber.js";
import { budgetAddressFor } from "../src/budget.js";

const alice = `0x${"11".repeat(20)}` as const;
const bob = `0x${"22".repeat(20)}` as const;
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
});
function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0); servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function setup(overrides: GatewayOptions = {}) {
  const served = vi.fn();
  const upstream = express().use(express.json());
  upstream.post("/v1/chat/completions", (_req, res) => {
    served();
    res.json({ choices: [{ message: { content: "paid answer" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  });
  const settle = vi.fn(async () => "0xconfirmed");
  const receipts = new MemoryReceiptLog();
  const subscriptionCredits = vi.fn(async () => 10n);
  const base = listen(createApp({
    verifySubscriber: async token => {
      if (token !== "valid-session") throw new SubscriberError(401, "authentication_required", "Invalid session");
      return [alice];
    },
    subscriptionCredits, settle, receipts,
    fallbackUpstream: listen(upstream), ...overrides,
  }));
  const chat = (token?: string, userHandle?: string, sse = false) => fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(sse ? { Accept: "text/event-stream" } : {}) },
    body: JSON.stringify({ model: "qwen", messages: [{ role: "user", content: "hello" }], ...(userHandle ? { userHandle } : {}) }),
  });
  return { chat, served, settle, receipts, subscriptionCredits, base };
}

describe("subscriber enforcement", () => {
  it("rejects anonymous requests and forged funded wallets before balance reads or upstream access", async () => {
    vi.stubEnv("DEFAULT_PAYER", alice);
    const ctx = await setup();
    for (const sse of [false, true]) {
      expect((await ctx.chat(undefined, undefined, sse)).status).toBe(401);
      expect((await ctx.chat(undefined, alice, sse)).status).toBe(401);
      expect((await ctx.chat("invalid-session", alice, sse)).status).toBe(401);
      expect((await ctx.chat("valid-session", bob, sse)).status).toBe(403);
    }
    expect(ctx.served.mock.calls).toHaveLength(0);
    expect(ctx.subscriptionCredits.mock.calls).toHaveLength(0);
    expect(await ctx.receipts.list()).toEqual([]);
  });

  it("binds a verified session to its linked wallet and confirms a debit", async () => {
    const ctx = await setup();
    const response = await ctx.chat("valid-session", alice);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tor_settled: true, choices: [{ message: { content: "paid answer" } }] });
    expect(ctx.subscriptionCredits.mock.calls[0]).toEqual([alice]);
    expect(ctx.settle.mock.calls[0]?.[0]).toBe(alice);
    expect((await ctx.receipts.list())[0]).toMatchObject({ user: `wallet:${alice}`, debitTx: "0xconfirmed" });
  });

  it.each([0n, null])("rejects unavailable or empty subscription balances (%s)", async credits => {
    const ctx = await setup({ subscriptionCredits: async () => credits });
    expect((await ctx.chat("valid-session", alice)).status).toBe(credits === null ? 503 : 402);
    expect(ctx.served.mock.calls).toHaveLength(0);
  });

  it("fails closed when billing or identity verification is unconfigured", async () => {
    for (const overrides of [{ settle: undefined }, { verifySubscriber: undefined }, { subscriptionCredits: undefined }]) {
      const ctx = await setup(overrides);
      expect((await ctx.chat("valid-session", alice)).status).toBe(503);
      expect(ctx.served.mock.calls).toHaveLength(0);
    }
  });

  it("API keys need credits in their own budget and cannot borrow a body wallet", async () => {
    vi.stubEnv("BUDGET_MASTER", `0x${"ab".repeat(32)}`);
    const keys = new MemoryKeyStore();
    const issued = issueKey(); await keys.save(issued.record);
    const subscriptionCredits = vi.fn(async () => 0n);
    const ctx = await setup({ keys, subscriptionCredits });
    expect((await ctx.chat(issued.key, alice)).status).toBe(402);
    expect(subscriptionCredits.mock.calls[0]).toEqual([budgetAddressFor(issued.record.prefix)]);
    expect(ctx.served.mock.calls).toHaveLength(0);
    subscriptionCredits.mockResolvedValue(10n);
    expect((await ctx.chat(issued.key, bob)).status).toBe(200);
    expect(ctx.settle.mock.calls[0]?.[0]).toBe(budgetAddressFor(issued.record.prefix));
    await keys.revoke(issued.record.prefix);
    expect((await ctx.chat(issued.key)).status).toBe(401);
  });

  it("does not release a completion after failed settlement", async () => {
    const ctx = await setup({ settle: async () => { throw new Error("debit reverted"); } });
    const response = await ctx.chat("valid-session", alice);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.type).toBe("settlement_pending");
    expect(body.choices).toBeUndefined();
  });

  it("protects operator-funded verification probes", async () => {
    const ctx = await setup({ adminToken: "operator-only" });
    expect((await fetch(`${ctx.base}/api/verify/${alice}`, { method: "POST" })).status).toBe(401);
    expect(ctx.served.mock.calls).toHaveLength(0);
  });

  it("rejects unlinked and malformed wallet selections", async () => {
    await expect(subscriberWallet("token", bob, async () => [alice])).rejects.toMatchObject({ status: 403 });
    await expect(subscriberWallet("token", "wallet:fake", async () => [alice])).rejects.toMatchObject({ status: 403 });
    await expect(subscriberWallet("token", undefined, async () => [])).rejects.toMatchObject({ status: 403 });
  });
});
