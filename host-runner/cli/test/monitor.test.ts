import { describe, expect, it, vi } from "vitest";
import { collectMonitor, decimalAmount, modelAvailable, parseHost, servingState, type MonitorSnapshot } from "../src/monitor.js";

const address = `0x${"1".repeat(40)}`;
const now = 1789080000000;
const rawHost = { address, active: true, modelId: "qwen2.5:0.5b", endpoint: "https://host.test", stake: "400000000", earningsWei: "25000000", calls24h: 7, fail24h: 1, receipts: [] };
const good = <T>(data: T) => ({ state: "ok" as const, data });
const base: MonitorSnapshot = {
  at: now, gateway: "https://gateway.test", address, linked: true,
  docker: good("28"), guard: good({ paid: false }), endpoint: good({ paid: false }),
  models: good([{ name: "qwen2.5:0.5b", size: 100, parameters: "0.5B", quantization: "Q4" }]),
  loaded: good([]), host: good(parseHost(rawHost)), network: good([]),
};

describe("host monitor", () => {
  it("separates a ready host from recent routed traffic", () => {
    expect(servingState(base).title).toBe("Ready to serve");
    const host = parseHost({ ...rawHost, receipts: [{ id: "receipt-1", ts: now - 1000 }] });
    expect(servingState({ ...base, host: good(host) }).title).toBe("Serving · recent traffic");
  });

  it("never treats registration alone as proof of serving", () => {
    expect(servingState({ ...base, endpoint: { state: "unavailable", message: "down" } }).title).toBe("Public endpoint unreachable");
    expect(servingState({ ...base, guard: { state: "unavailable", message: "down" } }).title).toBe("Local guard offline");
    expect(servingState({ ...base, models: good([]) }).title).toBe("Model missing");
    expect(servingState({ ...base, host: good(parseHost({ ...rawHost, verification: { failing: true } })) }).title).toBe("Out of rotation");
  });

  it("keeps failed lookups and unknown balances distinct from zero", () => {
    expect(servingState({ ...base, host: { state: "unavailable", message: "timeout" } }).title).toBe("Status unavailable");
    expect(servingState({ ...base, host: { state: "missing", message: "404" } }).title).toBe("Not listed");
    expect(parseHost({ ...rawHost, earningsWei: null, calls24h: undefined }).earnings).toBeNull();
    expect(decimalAmount(null, 8)).toBe("—");
    expect(decimalAmount("0", 8)).toBe("0");
    expect(decimalAmount("400000000", 8)).toBe("4");
    expect(decimalAmount("25000001", 8)).toBe("0.25000001");
  });

  it("uses exact model tags and rejects error bodies", () => {
    expect(modelAvailable([{ name: "qwen:latest", size: null, parameters: null, quantization: null }], "qwen")).toBe(true);
    expect(modelAvailable([{ name: "qwen:7b", size: null, parameters: null, quantization: null }], "qwen:0.5b")).toBe(false);
    expect(() => parseHost({ error: "not found" })).toThrow("invalid host");
  });

  it("collects public telemetry without exposing config secrets", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/api/hosts/${address}`)) return Response.json(rawHost);
      if (url.endsWith("/api/hosts")) return Response.json({ data: [rawHost] });
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: rawHost.modelId }] });
      if (url.endsWith("/api/ps")) return Response.json({ models: [] });
      return Response.json({ ok: true, service: "tor-guard", payTo: "" });
    });
    const snapshot = await collectMonitor({}, undefined, {
      config: () => ({ gateway: "https://gateway.test/", hostAddress: address, hostKey: "private-key-secret", token: "auth-secret", userId: "owner" }),
      fetch: fetcher, shell: vi.fn().mockResolvedValue({ ok: true, out: "28" }), now: () => now,
    });
    expect(servingState(snapshot).title).toBe("Ready to serve");
    expect(snapshot.host).toMatchObject({ state: "ok", data: { requests24h: 7, earnings: "25000000" } });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-key-secret|auth-secret/);
    expect(fetcher.mock.calls.some(([url]) => String(url) === "https://host.test/health")).toBe(true);
  });

  it("distinguishes a stopped Docker engine and a missing host while services fail", async () => {
    const snapshot = await collectMonitor({}, undefined, {
      config: () => ({ gateway: "https://gateway.test", hostAddress: address, token: null, userId: null }),
      fetch: vi.fn().mockResolvedValue(new Response("", { status: 404 })),
      shell: vi.fn().mockResolvedValueOnce({ ok: false, out: "socket unavailable" }).mockResolvedValue({ ok: true, out: "Docker version 28" }), now: () => now,
    });
    expect(snapshot.docker).toMatchObject({ state: "unavailable", message: expect.stringContaining("Engine stopped") });
    expect(snapshot.host.state).toBe("missing");
    expect(snapshot.endpoint.state).toBe("missing");
  });
});
