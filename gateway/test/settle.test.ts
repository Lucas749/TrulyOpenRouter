import { describe, expect, it, vi } from "vitest";
import { priceForCall, settleCall } from "../src/settle.js";
import type { HostInfo } from "../src/registry.js";

const host = {
  address: "0x1111111111111111111111111111111111111111",
  pricePerReq: 1000n,
  pricePer1kTokens: 100n,
} as HostInfo;

describe("settle", () => {
  it("prices base + per-1k tokens", () => {
    expect(priceForCall(host, 500, 500, 1n)).toBe(1000n + 1n * 100n);
    expect(priceForCall(host, 0, 2500, 1n)).toBe(1000n + 3n * 100n);
    expect(priceForCall(null, 999, 999)).toBe(1n);
  });

  it("converts delivered units to credits", () => {
    // 1 credit = 1e5 units (testnet REFUND_RATE)
    const h = { ...host, pricePerReq: 100000n, pricePer1kTokens: 100000n };
    expect(priceForCall(h, 500, 500)).toBe(2n);
    expect(priceForCall({ ...h, pricePerReq: 0n, pricePer1kTokens: 0n }, 10, 10)).toBe(0n);
  });

  it("settles via debit fn, never throws", async () => {
    const debit = vi.fn(async () => "0xabc123");
    const ok = await settleCall({ user: "u", host, promptTokens: 10, completionTokens: 10, receiptHash: "r" }, debit);
    expect(ok.settled).toBe(true);
    expect(ok.txHash).toBe("0xabc123");
    expect(ok.hostShare).toBe((ok.amountCredits * 9n) / 10n);
    expect(debit).toHaveBeenCalledWith("u", host.address, ok.amountCredits, "r");

    const failing = await settleCall(
      { user: "u", host, promptTokens: 10, completionTokens: 10, receiptHash: "r" },
      async () => { throw new Error("quota"); },
    );
    expect(failing.settled).toBe(false);
    expect(failing.error).toContain("quota");
  });
});
