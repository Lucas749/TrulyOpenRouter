import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, resolveHosts } from "../src/index.js";
import { MemoryHostRuntime, authorizeHostSettings } from "../src/host-runtime.js";
import { hostSettingsMessage, type HostSettings } from "../src/host-settings.js";
import { MemoryVerifier } from "../src/verify.js";
import type { HostInfo } from "../src/registry.js";

const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
const registry = `0x${"2".repeat(40)}` as const;
const settings = (): HostSettings => ({ address: account.address, registry, registeredModelId: "qwen2.5:0.5b", modelId: "deepseek-r1:8b", modelDigest: `0x${"3".repeat(64)}`, endpoint: "https://new-host.example", paused: false, revision: 1, expiresAt: Date.now() + 60000 });
const base: HostInfo = { address: account.address, registry, endpoint: "https://old-host.example", modelId: "qwen2.5:0.5b", modelDigest: `0x${"0".repeat(64)}`, pricePerReq: 100000n, pricePer1kTokens: 100000n, stake: 400000000n, active: true, lastHeartbeat: 1, latencyMs: 0, reliability: 1 };
const signature = (s: HostSettings) => account.signMessage({ message: hostSettingsMessage(s) });

describe("host runtime settings", () => {
  it("rejects tampering, expired intents, and another key", async () => {
    const s = settings(), sig = await signature(s);
    await expect(authorizeHostSettings({ ...s, paused: true }, sig)).rejects.toMatchObject({ status: 403 });
    await expect(authorizeHostSettings({ ...s, expiresAt: 0 }, sig)).rejects.toMatchObject({ status: 400 });
    await expect(authorizeHostSettings({ ...s, address: registry }, sig)).rejects.toMatchObject({ status: 403 });
    await expect(authorizeHostSettings({ ...s, endpoint: "https://user:secret@host.example" }, sig)).rejects.toMatchObject({ status: 400 });
  });

  it("publishes model and endpoint changes, drains paused hosts, and rejects replays or unstaked hosts", async () => {
    const runtime = new MemoryHostRuntime();
    let active = true;
    const opts = { registry, runtime, knownModels: [base.modelId], fetchHosts: async (model: string) => model === base.modelId ? [{ ...base, active }] : [] };
    const server = createApp(opts).listen(0);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (s: HostSettings) => fetch(`${url}/api/hosts/${account.address}/runtime`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: s, signature: await signature(s) }) });
    try {
      const s = settings();
      expect((await post(s)).status).toBe(200);
      expect((await post(s)).status).toBe(409);
      expect(await resolveHosts(opts, base.modelId)).toEqual([]);
      expect(await resolveHosts(opts, s.modelId)).toMatchObject([{ endpoint: s.endpoint, modelId: s.modelId, registeredModelId: base.modelId, stake: base.stake, active: true }]);
      expect((await (await fetch(`${url}/v1/models`)).json()).data).toContainEqual(expect.objectContaining({ id: s.modelId, hosts: 1 }));
      expect((await post({ ...s, revision: 2, paused: true })).status).toBe(200);
      expect((await resolveHosts(opts, s.modelId))[0].active).toBe(false);
      expect((await (await fetch(`${url}/v1/models`)).json()).data).toContainEqual(expect.objectContaining({ id: s.modelId, hosts: 0 }));
      active = false;
      expect((await post({ ...s, revision: 3 })).status).toBe(403);
      expect((await resolveHosts(opts, s.modelId))[0].active).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("accepts only one concurrent update for a revision", async () => {
    const store = new MemoryHostRuntime(), s = settings();
    const record = await authorizeHostSettings(s, await signature(s));
    expect((await Promise.all([store.put(record), store.put(record)])).filter(Boolean)).toHaveLength(1);
  });

  it("does not apply another model's verification result after a switch", async () => {
    const verifier = new MemoryVerifier();
    await verifier.record({ host: account.address, modelId: base.modelId, ts: Date.now(), passed: 5, total: 5, score: 1, inconclusive: false, results: [] });
    expect((await verifier.verification(account.address, base.modelId)).checks).toBe(1);
    expect(await verifier.verification(account.address, "deepseek-r1:8b")).toMatchObject({ checks: 0, avgScore: null });
    expect((await verifier.verification(account.address, base.modelId)).checks).toBe(1);
  });
});
