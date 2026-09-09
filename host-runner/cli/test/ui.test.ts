import { describe, expect, it } from "vitest";
import { banner, box, frames, mark, renderSteps, stepIcon } from "../src/ui.js";

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

  it("banner goes quiet under TOR_QUIET (orchestrated runs)", () => {
    const prev = process.env.TOR_QUIET;
    process.env.TOR_QUIET = "1";
    try {
      expect(banner()).toBe("");
    } finally {
      if (prev === undefined) delete process.env.TOR_QUIET;
      else process.env.TOR_QUIET = prev;
    }
    expect(banner()).toContain("TrulyOpenRouter");
  });

  it("brand mark rows share one width, banner keeps name + tagline", () => {
    const rows = mark().replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => [...r].length)).size).toBe(1);
    expect(banner()).toContain("TrulyOpenRouter");
    expect(banner()).toContain("except open");
  });
});
