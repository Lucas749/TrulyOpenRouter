import { describe, expect, it } from "vitest";
import { validCode } from "../src/config.js";

describe("cli config", () => {
  it("validates device codes", () => {
    expect(validCode("abc123")).toBe(true);
    expect(validCode("  k7m2p9 ")).toBe(true);
    expect(validCode("abc12")).toBe(false);
    expect(validCode("abc1234")).toBe(false);
    expect(validCode("abc!23")).toBe(false);
    expect(validCode("abcO23")).toBe(false); // no confusables
  });
});
