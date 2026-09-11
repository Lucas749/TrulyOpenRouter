import { describe, expect, it, vi } from "vitest";
import { proxyChat, proxyWithFallback, selectUpstream, shouldPayRetry, UpstreamError } from "../src/upstream.js";
import type { HostInfo } from "../src/registry.js";

const mk = (over: Partial<HostInfo> = {}): HostInfo => ({
  address: "0x1111111111111111111111111111111111111111",
  endpoint: "http://h1:11434",
  modelId: "llama-3.1-8b",
  modelDigest: "0xabc",
  pricePerReq: 1000n,
  pricePer1kTokens: 100n,
  stake: BigInt(1e18),
  active: true,
  lastHeartbeat: 0,
  latencyMs: 200,
  reliability: 1,
  ...over,
});

describe("selectUpstream", () => {
  it("picks cheapest eligible host for the model", async () => {
    const hosts = [mk({ endpoint: "http://slow:11434", pricePerReq: 9000n }), mk()];
    const up = await selectUpstream("llama-3.1-8b", async () => hosts);
    expect(up.endpoint).toBe("http://h1:11434");
    expect(up.host?.pricePerReq).toBe(1000n);
  });

  it("falls back when registry is empty", async () => {
    const up = await selectUpstream("llama-3.1-8b", async () => [], "http://localhost:11434");
    expect(up).toMatchObject({ host: null, endpoint: "http://localhost:11434" });
  });

  it("throws when nothing can serve", async () => {
    await expect(selectUpstream("nope", async () => [])).rejects.toThrow("no hosts");
  });
});

describe("proxyChat", () => {
  it("posts body to host chat endpoint", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ hi: 1 }) }));
    const out = await proxyChat("http://h1:11434", { model: "m" }, fetchFn as any);
    expect(out).toEqual({ hi: 1 });
    expect(fetchFn.mock.calls[0][0]).toBe("http://h1:11434/v1/chat/completions");
  });

  it("keeps explicit /v1 bases intact", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    await proxyChat("http://h1:1234/v1/", { model: "m" }, fetchFn as any);
    expect(fetchFn.mock.calls[0][0]).toBe("http://h1:1234/v1/chat/completions");
  });

  it("retries gated hosts with paid fetch only on 402 with creds", async () => {
    const gated = async () => ({ ok: false, status: 402 });
    const paid = vi.fn(async () => ({ ok: true, json: async () => ({ paid: true }) }));
    const r = await proxyWithFallback("http://h1:11434", {}, { accountId: "a", privateKey: "k" }, paid as any, undefined, gated as any);
    expect(r).toEqual({ out: { paid: true }, paid: true });

    await expect(proxyWithFallback("http://h1", {}, undefined, paid as any, undefined, gated as any)).rejects.toThrow("upstream 402");
    await expect(proxyWithFallback("http://h1", {}, { accountId: "a", privateKey: "k" }, undefined, undefined, gated as any)).rejects.toThrow("upstream 402");

    expect(shouldPayRetry(new UpstreamError(402, "u"), true)).toBe(true);
    expect(shouldPayRetry(new UpstreamError(402, "u"), false)).toBe(false);
    expect(shouldPayRetry(new UpstreamError(500, "u"), true)).toBe(false);
    expect(shouldPayRetry(new Error("x"), true)).toBe(false);
  });

  it("retains the confirmed host payment transaction separately from the response body", async () => {
    const gated = vi.fn(async () => new Response(null, { status: 402 }));
    const payment = { success: true, network: "hedera:testnet", transaction: "0.0.123@1789000000.123456789" };
    const paid = vi.fn(async () => Response.json({ choices: [] }, { headers: { "payment-response": Buffer.from(JSON.stringify(payment)).toString("base64") } }));
    const result = await proxyWithFallback("https://host.test", {}, { accountId: "a", privateKey: "k" }, paid, undefined, gated);
    expect(result.x402Transaction).toBe(payment.transaction);
    expect(result.paid).toBe(true);
  });

  it("throws on upstream error", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(proxyChat("http://h1:11434", {}, fetchFn as any)).rejects.toThrow("upstream 500");
  });
});
