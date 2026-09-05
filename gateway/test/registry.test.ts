import { describe, expect, it, vi } from "vitest";
import { fetchEligibleHosts } from "../src/registry.js";

const ADDRS = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"] as const;

function fakeClient() {
  return {
    readContract: vi.fn(async ({ functionName }: any) => {
      if (functionName === "eligibleHosts") return [...ADDRS];
      return {
        endpoint: "http://h:11434",
        modelId: "llama-3.1-8b",
        modelDigest: "0xabc",
        imageDigest: "0xdef",
        pricePerReq: 1000n,
        pricePer1kTokens: 100n,
        teePubkey: "0x",
        stake: 5n,
        active: true,
        registeredAt: 1,
        lastHeartbeat: 2,
        releaseAfter: 0,
        challenged: false,
      };
    }),
  } as any;
}

describe("fetchEligibleHosts", () => {
  it("maps registry rows to HostInfo", async () => {
    const hosts = await fetchEligibleHosts(fakeClient(), "0x0000000000000000000000000000000000000000", "llama-3.1-8b");
    expect(hosts).toHaveLength(2);
    expect(hosts[0]).toMatchObject({ endpoint: "http://h:11434", pricePerReq: 1000n, active: true });
  });

  it("returns empty when none eligible", async () => {
    const c = fakeClient();
    c.readContract.mockResolvedValueOnce([]);
    const hosts = await fetchEligibleHosts(c, "0x0000000000000000000000000000000000000000", "nope");
    expect(hosts).toEqual([]);
  });
});
