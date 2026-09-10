import { describe, expect, it, vi } from "vitest";
import { operateHost } from "../src/host-lifecycle.js";
import type { HostSettings } from "../src/host-settings.js";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
const settings: HostSettings = { address: account.address, registry: `0x${"2".repeat(40)}`, registeredModelId: "qwen2.5:0.5b", modelId: "qwen2.5:0.5b", modelDigest: `0x${"0".repeat(64)}`, endpoint: "https://old.trycloudflare.com", paused: false, revision: 1, expiresAt: 0 };
function dependencies() {
  const events: string[] = [];
  return { events,
    current: vi.fn(async () => ({ ...settings })),
    publish: vi.fn(async (s: HostSettings) => { events.push(s.paused ? "pause" : "enable"); return { ...s, revision: s.revision + 1 }; }),
    start: vi.fn(async () => { events.push("start"); }), stop: vi.fn(async () => { events.push("stop"); }),
    tunnel: vi.fn(async () => { events.push("tunnel"); return "https://new.trycloudflare.com"; }),
    stopTunnel: vi.fn(async () => { events.push("stopTunnel"); }),
    model: vi.fn(async () => { events.push("model"); return settings.modelDigest; }),
  };
}

describe("host lifecycle", () => {
  it("drains routing before shutdown and enables it only after model and tunnel readiness", async () => {
    const d = dependencies();
    await operateHost("restart", d);
    expect(d.events).toEqual(["pause", "stop", "stopTunnel", "start", "model", "tunnel", "enable"]);
    expect(d.publish.mock.calls[1][0]).toMatchObject({ endpoint: "https://new.trycloudflare.com", paused: false, revision: 2, registry: settings.registry });
  });
  it("keeps the prior model and routing state when a download fails", async () => {
    const d = dependencies(); d.model.mockRejectedValue(new Error("download failed"));
    await expect(operateHost("model", d, "deepseek-r1:8b")).rejects.toThrow("download failed");
    expect(d.publish.mock.calls).toHaveLength(0);
    expect(d.stop.mock.calls).toHaveLength(0);
  });
  it("updates a paused host's model without enabling routes", async () => {
    const d = dependencies(); d.current.mockResolvedValue({ ...settings, paused: true });
    expect(await operateHost("model", d, "deepseek-r1:8b")).toContain("remains paused");
    expect(d.publish.mock.calls[0][0]).toMatchObject({ modelId: "deepseek-r1:8b", paused: true });
  });
  it("stops locally during an outage but reports that network pause is unconfirmed", async () => {
    const d = dependencies(); d.current.mockRejectedValue(new Error("gateway down"));
    await expect(operateHost("stop", d)).rejects.toThrow("Network pause is unconfirmed");
    expect(d.events).toEqual(["stop", "stopTunnel"]);
  });
  it("does not resume when the pause update fails during restart", async () => {
    const d = dependencies(); d.publish.mockRejectedValue(new Error("conflict"));
    await expect(operateHost("restart", d)).rejects.toThrow("pause is unconfirmed");
    expect(d.start.mock.calls).toHaveLength(0);
    expect(d.stop.mock.calls).toHaveLength(1);
  });

});
