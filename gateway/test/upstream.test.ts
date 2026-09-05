import { describe, expect, it, vi } from "vitest";
import { proxyChat, selectUpstream } from "../src/upstream.js";
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
    expect(fetchFn.mock.calls[0][0]).toBe("http://h1:11434/chat/completions");
  });

  it("throws on upstream error", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500 }));
    await expect(proxyChat("http://h1:11434", {}, fetchFn as any)).rejects.toThrow("upstream 500");
  });
});
