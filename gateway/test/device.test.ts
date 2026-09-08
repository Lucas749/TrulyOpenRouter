import { describe, expect, it } from "vitest";
import { MemoryDeviceFlow } from "../src/device.js";

describe("device flow", () => {
  it("issues, polls pending, approves, polls approved", async () => {
    const f = new MemoryDeviceFlow();
    const { code } = await f.issue();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(await f.poll(code)).toMatchObject({ status: "pending" });
    expect(await f.poll("ZZZZZZ")).toMatchObject({ status: "unknown" });
    const ok = await f.approve(code.toLowerCase(), "user-1");
    expect(ok?.token.startsWith("tor_dev_")).toBe(true);
    expect(await f.poll(code)).toMatchObject({ status: "approved", userId: "user-1" });
  });

  it("rejects bad approvals", async () => {
    const f = new MemoryDeviceFlow();
    expect(await f.approve("NOPE12", "u")).toBeNull();
    const { code } = await f.issue();
    expect(await f.approve(code, "")).toBeNull();
  });
});
