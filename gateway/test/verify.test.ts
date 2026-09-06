import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLICY,
  isFailing,
  MemoryVerifier,
  normalizeCompletion,
  PROBES,
  scoreProbe,
  spotCheck,
  type CheckReport,
} from "../src/verify.js";

function stubFetch(answers: Record<string, string>, failIds: string[] = []) {
  return vi.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const prompt: string = body.messages?.[0]?.content ?? "";
    if (failIds.some((f) => prompt.includes(f))) throw new Error("boom");
    const key = Object.keys(answers).find((k) => prompt.includes(k)) ?? "";
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: answers[key] ?? "" } }] }),
    };
  });
}

const TARGET = { address: "0xabc", endpoint: "http://host:11434", modelId: "tiny-test" };
const REFS = { "cap-france": "Paris", arith: "42", repeat: "blue seven quiet" };

describe("normalizeCompletion", () => {
  it("ignores case, whitespace and trailing punctuation", () => {
    expect(normalizeCompletion("  Paris. ")).toBe("paris");
    expect(normalizeCompletion("BLUE   seven\nquiet")).toBe("blue seven quiet");
    expect(scoreProbe("Paris.", "paris")).toBe(true);
    expect(scoreProbe("Lyon", "paris")).toBe(false);
  });
});

describe("PROBES", () => {
  it("battery is small, deterministic and well-formed", () => {
    expect(PROBES.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(PROBES.map((p) => p.id));
    expect(ids.size).toBe(PROBES.length);
    for (const p of PROBES) expect(p.maxTokens).toBeLessThanOrEqual(16);
  });
});

describe("spotCheck", () => {
  it("scores matches against references with deterministic params", async () => {
    const fetchFn = stubFetch({ France: "Paris", "17 + 25": "42", "blue seven": "BLUE SEVEN QUIET" });
    const report = await spotCheck(TARGET, PROBES.slice(0, 3), REFS, { fetchFn } as any);
    expect(report.total).toBe(3);
    expect(report.passed).toBe(3);
    expect(report.score).toBe(1);
    expect(report.inconclusive).toBe(false);
    const sent = JSON.parse(String(fetchFn.mock.calls[0][1].body));
    expect(sent.temperature).toBe(0);
    expect(sent.seed).toBe(42);
    expect(sent.stream).toBe(false);
  });

  it("counts mismatches and skips probes without references", async () => {
    const fetchFn = stubFetch({ France: "Lyon", "17 + 25": "42", "blue seven": "blue seven quiet" });
    const report = await spotCheck(TARGET, PROBES, REFS, { fetchFn } as any);
    expect(report.total).toBe(3); // backwards + month have no references
    expect(report.passed).toBe(2);
    expect(report.score).toBeCloseTo(2 / 3);
  });

  it("treats transport errors as inconclusive, never as failures", async () => {
    const fetchFn = stubFetch({}, ["France", "17", "blue"]);
    const report = await spotCheck(TARGET, PROBES.slice(0, 3), REFS, { fetchFn } as any);
    expect(report.inconclusive).toBe(true);
    expect(report.score).toBeNull();
    expect(report.total).toBe(0);
  });
});

function report(score: number | null, ts = 1): CheckReport {
  return {
    host: "0xabc",
    modelId: "m",
    ts,
    passed: 0,
    total: 1,
    score,
    inconclusive: score === null,
    results: [],
  };
}

describe("isFailing", () => {
  it("needs consecutive conclusive sub-threshold rounds", () => {
    expect(isFailing([], DEFAULT_POLICY)).toBe(false);
    expect(isFailing([report(0), report(0)], DEFAULT_POLICY)).toBe(false); // only 2 of 3
    expect(isFailing([report(0), report(0), report(0)], DEFAULT_POLICY)).toBe(true);
    expect(isFailing([report(0), report(1), report(0)], DEFAULT_POLICY)).toBe(false); // streak broken
    expect(isFailing([report(0), report(null), report(0), report(0)], DEFAULT_POLICY)).toBe(true); // inconclusive pauses
    expect(isFailing([report(0.7), report(0.7), report(0.7)], DEFAULT_POLICY)).toBe(false); // above threshold
  });
});

describe("MemoryVerifier", () => {
  it("rolls history, summarizes and gates routing", () => {
    const v = new MemoryVerifier(10, DEFAULT_POLICY);
    expect(v.verification("0xABC")).toEqual({ lastCheck: null, checks: 0, avgScore: null, failing: false });
    expect(v.scoreMultiplier("0xabc")).toBe(1); // unchecked routes normally
    v.record(report(1, 1));
    v.record(report(0.5, 2));
    const s = v.verification("0xabc");
    expect(s.checks).toBe(2);
    expect(s.avgScore).toBeCloseTo(0.75);
    expect(s.failing).toBe(false);
    expect(v.scoreMultiplier("0xabc")).toBeCloseTo(0.875);
    v.record(report(0, 3));
    v.record(report(0, 4));
    v.record(report(0, 5));
    expect(v.verification("0xabc").failing).toBe(true);
    expect(v.scoreMultiplier("0xabc")).toBe(0);
  });
});
