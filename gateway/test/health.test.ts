import { describe, expect, it } from "vitest";
import { MemoryHealth } from "../src/health.js";

describe("health", () => {
  it("counts 24h failures and derives reliability", () => {
    const h = new MemoryHealth();
    expect(h.reliability(0, "0xabc")).toBeNull();
    h.recordFail("0xABC", 1000);
    h.recordFail("0xabc", 2000);
    expect(h.fails24h("0xabc", 3000)).toBe(2);
    expect(h.reliability(8, "0xabc", 3000)).toBe(0.8);
    // window expiry
    expect(h.fails24h("0xabc", 100_000_000)).toBe(0);
    expect(h.reliability(8, "0xabc", 100_000_000)).toBe(1);
  });

  it("tracks latency EMA per host", () => {
    const h = new MemoryHealth();
    expect(h.latencyMs("0xabc")).toBeNull();
    h.recordLatency("0xABC", 100);
    expect(h.latencyMs("0xabc")).toBe(100);
    h.recordLatency("0xabc", 200); // 0.3*200 + 0.7*100 = 130
    expect(h.latencyMs("0xabc")).toBe(130);
  });
});
