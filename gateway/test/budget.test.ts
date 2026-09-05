import { describe, expect, it } from "vitest";
import { deriveBudgetAddress, deriveBudgetKey } from "../src/budget.js";

const MASTER = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("budget derivation", () => {
  it("derives deterministically, distinctly, validly", () => {
    const a1 = deriveBudgetAddress(MASTER, "tor_sk_abc");
    const a2 = deriveBudgetAddress(MASTER, "tor_sk_abc");
    const b = deriveBudgetAddress(MASTER, "tor_sk_xyz");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(deriveBudgetKey(MASTER, "tor_sk_abc")).toBe(deriveBudgetKey(MASTER, "tor_sk_abc"));
  });

  it("rejects bad masters", () => {
    expect(() => deriveBudgetKey("0x1234", "p")).toThrow("32 bytes");
  });
});
