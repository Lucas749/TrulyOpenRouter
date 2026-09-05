import { describe, expect, it } from "vitest";
import { box, frames, renderSteps, stepIcon } from "../src/ui.js";

describe("ui kit", () => {
  it("renders steps with state icons", () => {
    const out = renderSteps([
      { label: "docker", state: "done" },
      { label: "pull", state: "active", detail: "40%" },
      { label: "register", state: "pending" },
      { label: "boom", state: "fail" },
    ]);
    expect(out).toContain("docker");
    expect(out).toContain("40%");
    expect(stepIcon("done")).toContain("32m"); // green
    expect(stepIcon("fail")).toContain("31m"); // red
  });

  it("draws boxes with title bars", () => {
    const b = box("Code", ["ABC234", "second line"]);
    expect(b).toContain("Code");
    expect(b).toContain("ABC234");
    expect(b.split("\n")).toHaveLength(4);
  });

  it("exposes spinner frames", () => {
    expect(frames()).toHaveLength(10);
    expect(new Set(frames()).size).toBe(10);
  });
});
