import { afterEach, expect, it, vi } from "vitest";
import { createApp, resolveHosts } from "../src/index.js";
import { fetchEligibleHosts } from "../src/registry.js";

vi.mock("../src/registry.js", async (original) => ({
  ...await original<typeof import("../src/registry.js")>(),
  fetchEligibleHosts: vi.fn(),
}));

const primary = `0x${"1".repeat(40)}` as const;
const legacy = `0x${"2".repeat(40)}` as const;
const opts = { registry: primary, legacyRegistries: [legacy], rpcUrl: "http://rpc.invalid" };
const modelId = "qwen2.5:0.5b";
const bootstrap = { address: `0x${"3".repeat(40)}`, modelId, endpoint: "http://guard:4122" };
const registered = { ...bootstrap, address: `0x${"4".repeat(40)}` as const, registry: primary, modelDigest: "0xabc" as const, pricePerReq: 1n, pricePer1kTokens: 1n, stake: 400_000_000n, active: true, lastHeartbeat: 1, latencyMs: 250, reliability: 1 };

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("publishes the current and legacy registries for host clients", async () => {
  const server = createApp(opts).listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    expect(config).toMatchObject({ registry: primary, legacyRegistries: [legacy] });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("discovers new hosts alongside bootstrap and legacy hosts", async () => {
  vi.stubEnv("HOSTS_JSON", JSON.stringify([bootstrap]));
  vi.mocked(fetchEligibleHosts).mockImplementation(async (_, registry) => registry === primary
    ? [registered] : [{ ...registered, address: `0x${"5".repeat(40)}`, registry: legacy }]);
  const hosts = await resolveHosts(opts, modelId);
  expect(hosts.map((h) => h.address)).toEqual(expect.arrayContaining([bootstrap.address, registered.address, `0x${"5".repeat(40)}`]));
  expect(hosts).toHaveLength(3);
});

it("prefers primary records when the same key exists on both registries", async () => {
  vi.stubEnv("HOSTS_JSON", "");
  vi.mocked(fetchEligibleHosts).mockImplementation(async (_, registry) => [{ ...registered, registry }]);
  expect(await resolveHosts(opts, modelId)).toEqual([registered]);
});

it("keeps bootstrap service available during a registry outage", async () => {
  vi.stubEnv("HOSTS_JSON", JSON.stringify([bootstrap]));
  vi.mocked(fetchEligibleHosts).mockRejectedValue(new Error("RPC unavailable"));
  expect(await resolveHosts(opts, modelId)).toMatchObject([bootstrap]);
});

it("reports discovery failure if no source is available", async () => {
  vi.stubEnv("HOSTS_JSON", "");
  vi.mocked(fetchEligibleHosts).mockRejectedValue(new Error("RPC unavailable"));
  await expect(resolveHosts(opts, modelId)).rejects.toThrow("Host registries are unavailable");
});
