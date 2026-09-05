import { describe, expect, it } from "vitest";
import { rankHosts, scoreHost } from "../src/score.js";
import type { HostInfo } from "../src/registry.js";

const base: HostInfo = {
  address: "0x1111111111111111111111111111111111111111",
  endpoint: "http://h:11434",
  modelId: "m",
  modelDigest: "0xabc",
  pricePerReq: 1000n,
  pricePer1kTokens: 100n,
  stake: BigInt(1e18),
  active: true,
  lastHeartbeat: 0,
  latencyMs: 200,
  reliability: 1,
};

describe("scoreHost", () => {
  it("prefers cheaper hosts", () => {
    const cheap = { ...base };
    const pricey = { ...base, pricePerReq: 999_000n };
    expect(scoreHost(cheap)).toBeLessThan(scoreHost(pricey));
  });

  it("prefers faster, higher-stake, reliable hosts", () => {
    const good = { ...base };
    const bad = { ...base, latencyMs: 5000, stake: 1n, reliability: 0.2 };
    expect(scoreHost(good)).toBeLessThan(scoreHost(bad));
  });
});

describe("rankHosts", () => {
  it("drops inactive hosts and sorts best-first", () => {
    const off = { ...base, address: "0x2222222222222222222222222222222222222222", active: false };
    const pricey = { ...base, address: "0x3333333333333333333333333333333333333333", pricePerReq: 5000n };
    const ranked = rankHosts([pricey, off, base]);
    expect(ranked.map((h) => h.address)).toEqual([base.address, pricey.address]);
  });
});
