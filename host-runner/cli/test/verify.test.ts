import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAge, formatVerification, verifyHost } from "../src/verify.js";

describe("formatAge", () => {
  const now = 1_700_000_000_000;
  it("renders human durations", () => {
    expect(formatAge(now - 5_000, now)).toBe("5s ago");
    expect(formatAge(now - 12 * 60_000, now)).toBe("12m ago");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAge(now - 5 * 86_400_000, now)).toBe("5d ago");
    expect(formatAge(now + 60_000, now)).toBe("0s ago"); // future clamps
  });
});

describe("formatVerification", () => {
  const now = 1_700_000_000_000;
  it("is honest about the unchecked state", () => {
    expect(formatVerification(null, now)).toContain("unchecked");
    expect(formatVerification({ lastCheck: null, checks: 0, avgScore: null, failing: false }, now)).toContain("unchecked");
  });

  it("summarizes passing hosts", () => {
    const out = formatVerification({ lastCheck: now - 120_000, checks: 3, avgScore: 1, failing: false }, now);
    expect(out).toContain("✓ 100%");
    expect(out).toContain("3 checks");
    expect(out).toContain("2m ago");
  });

  it("warns loudly on failing hosts", () => {
    const out = formatVerification({ lastCheck: now, checks: 3, avgScore: 0, failing: true }, now);
    expect(out).toContain("FAILING");
    expect(out).toContain("out of rotation");
  });
});

describe("verifyHost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prints per-probe results with expected-vs-got on mismatch", async () => {
    // minimal Response shape our code touches: res.ok + res.json()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          host: "0xabc",
          modelId: "m",
          passed: 1,
          total: 2,
          score: 0.5,
          inconclusive: false,
          results: [
            { probeId: "arith", match: true, expected: "42", got: "42" },
            { probeId: "month", match: false, expected: "october", got: "july" },
          ],
          verification: { failing: false },
        }),
      })) as any,
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: any[]) => void lines.push(a.join(" ")));
    await verifyHost("http://gw:4021", "0xabc");
    const out = lines.join("\n");
    expect(out).toContain("1/2");
    expect(out).toContain("✓ arith");
    expect(out).toContain('expected "october" got "july"');
    expect(out).not.toContain("FAILING");
  });

  it("flags failing hosts and surfaces gateway errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          host: "0xabc",
          modelId: "m",
          passed: 0,
          total: 5,
          score: 0,
          inconclusive: false,
          results: [],
          verification: { failing: true },
        }),
      })) as any,
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: any[]) => void lines.push(a.join(" ")));
    await verifyHost("http://gw:4021", "0xabc");
    expect(lines.join("\n")).toContain("FAILING");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "unknown host" } }) })) as any,
    );
    await expect(verifyHost("http://gw:4021", "0xabc")).rejects.toThrow("unknown host");
  });
});
