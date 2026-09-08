import { describe, expect, it } from "vitest";
import { hbarWeiToHbar, hbarWeiToUsd, usdToHbarWei, usdToUsdcUnits } from "./fx";

describe("fx", () => {
  it("converts $10 at Sep-2026 indicative rates", () => {
    expect(usdToHbarWei(10)).toBe(String(BigInt(125e18))); // 125 HBAR @ $0.08
    expect(usdToUsdcUnits(10)).toBe("10000000");
    expect(hbarWeiToHbar("125000000000000000000")).toBe(125);
    expect(hbarWeiToUsd("125000000000000000000")).toBeCloseTo(10, 8);
    expect(() => usdToHbarWei(0)).toThrow("positive");
    expect(() => usdToHbarWei(NaN)).toThrow("positive");
  });
});
