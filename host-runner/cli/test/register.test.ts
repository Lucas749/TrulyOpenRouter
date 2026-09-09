import { describe, expect, it } from "vitest";
import { shouldRegister } from "../src/run.js";

describe("shouldRegister (idempotent re-runs)", () => {
  it("registers fresh keys", () => {
    expect(shouldRegister(null)).toBe(true);
  });

  it("skips active hosts (no double stake)", () => {
    expect(shouldRegister({ active: true, stake: 10n * 10n ** 18n })).toBe(false);
  });

  it("re-registers inactive records (deregistered/expired)", () => {
    expect(shouldRegister({ active: false, stake: 0n })).toBe(true);
  });
});
