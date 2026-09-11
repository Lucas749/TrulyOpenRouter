import { describe, expect, it, vi } from "vitest";
import { EndpointAvailability } from "../src/availability.js";
import { resolveHosts } from "../src/index.js";
import { selectUpstream } from "../src/upstream.js";
import type { HostInfo } from "../src/registry.js";

describe("endpoint availability", () => {
  it("requires a real guard response and reports the payment mode", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, service: "tor-guard", payTo: "0.0.123" }))
      .mockResolvedValueOnce(Response.json({ ok: true, service: "tor-guard", payTo: "" }))
      .mockResolvedValueOnce(new Response("Tunnel unavailable", { status: 530 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const probe = new EndpointAvailability(fetcher);
    expect(await probe.check("https://paid.test/v1")).toMatchObject({ reachable: true, paymentMode: "x402" });
    expect(fetcher.mock.calls[0][0]).toBe("https://paid.test/health");
    expect(await probe.check("https://demo.test")).toMatchObject({ reachable: true, paymentMode: "demo" });
    expect((await probe.check("https://dead.test")).reachable).toBe(false);
    expect((await probe.check("https://unrelated.test")).reachable).toBe(false);
  });

  it("shares concurrent probes and refreshes after cache expiry", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, service: "tor-guard" }));
    const probe = new EndpointAvailability(fetcher, 20);
    await Promise.all([probe.check("https://host.test"), probe.check("https://host.test")]);
    await probe.check("https://host.test");
    expect(fetcher.mock.calls).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 25));
    await probe.check("https://host.test");
    expect(fetcher.mock.calls).toHaveLength(2);
  });

  it("keeps registrations visible but excludes unreachable endpoints from routing", async () => {
    const host = { address: "0x0000000000000000000000000000000000000001", endpoint: "https://old.test", modelId: "qwen2.5:0.5b", active: true, pricePerReq: 1n, pricePer1kTokens: 1n, stake: 4n, latencyMs: 200, reliability: 1 } as HostInfo;
    const opts = { fetchHosts: async () => [host], availability: { check: async () => ({ reachable: false, checkedAt: Date.now(), paymentMode: "unknown" as const }) } };
    const hosts = await resolveHosts(opts, host.modelId);
    expect(hosts[0]).toMatchObject({ registeredActive: true, active: false, availability: { reachable: false } });
    await expect(selectUpstream(host.modelId, async () => hosts)).rejects.toThrow("no hosts");
  });
});
