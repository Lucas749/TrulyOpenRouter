import { describe, expect, it } from "vitest";
import { unitsToUsd, usdLabel } from "./money";

describe("money display", () => {
  it("converts delivered units at 1e5 = 1 credit = $0.001", () => {
    expect(unitsToUsd(100000)).toBe(0.001);
    expect(unitsToUsd("1")).toBe(1e-8);
    expect(unitsToUsd(null)).toBeNull();
    expect(unitsToUsd("junk")).toBeNull();
    expect(usdLabel(100000)).toBe("$0.0010");
    expect(usdLabel(1)).toBe("$1.0e-8");
    expect(usdLabel(null)).toBe("—");
  });
});
