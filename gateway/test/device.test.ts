import { describe, expect, it } from "vitest";
import { MemoryDeviceFlow } from "../src/device.js";

describe("device flow", () => {
  it("issues, polls pending, approves, polls approved", () => {
    const f = new MemoryDeviceFlow();
    const { code } = f.issue();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(f.poll(code)).toMatchObject({ status: "pending" });
    expect(f.poll("ZZZZZZ")).toMatchObject({ status: "unknown" });
    const ok = f.approve(code.toLowerCase(), "user-1");
    expect(ok?.token.startsWith("tor_dev_")).toBe(true);
    expect(f.poll(code)).toMatchObject({ status: "approved", userId: "user-1" });
  });

  it("rejects bad approvals", () => {
    const f = new MemoryDeviceFlow();
    expect(f.approve("NOPE12", "u")).toBeNull();
    const { code } = f.issue();
    expect(f.approve(code, "")).toBeNull();
  });
});
