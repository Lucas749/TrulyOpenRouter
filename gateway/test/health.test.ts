import { describe, expect, it } from "vitest";
import { MemoryHealth } from "../src/health.js";

describe("health", () => {
  it("counts 24h failures and derives reliability", async () => {
    const h = new MemoryHealth();
    expect(await h.reliability(0, "0xabc")).toBeNull();
    await h.recordFail("0xABC", 1000);
    await h.recordFail("0xabc", 2000);
    expect(await h.fails24h("0xabc", 3000)).toBe(2);
    expect(await h.reliability(8, "0xabc", 3000)).toBe(0.8);
    // window expiry
    expect(await h.fails24h("0xabc", 100_000_000)).toBe(0);
    expect(await h.reliability(8, "0xabc", 100_000_000)).toBe(1);
  });

  it("tracks latency EMA per host", async () => {
    const h = new MemoryHealth();
    expect(await h.latencyMs("0xabc")).toBeNull();
    await h.recordLatency("0xABC", 100);
    expect(await h.latencyMs("0xabc")).toBe(100);
    await h.recordLatency("0xabc", 200); // 0.3*200 + 0.7*100 = 130
    expect(await h.latencyMs("0xabc")).toBe(130);
  });
});
