import { createRequire } from "module";

/// @notice Reference outputs, captured from a trusted run of the serving stack
/// (scripts/capture-references.mjs). Keyed by exact modelId string.
export interface ReferenceSet {
  stack: string;
  capturedAt: string;
  refs: Record<string, string>;
}

export function loadReferences(): Record<string, ReferenceSet> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const require = createRequire(import.meta.url);
    return require("../references.json") as Record<string, ReferenceSet>;
  } catch {
    return {};
  }
}

export { sha256hex } from "./receipts.js";

/// @notice Model-identity spot checks: does the host actually serve the model it claims?
/// Sends deterministic fingerprint probes (temperature 0, fixed seed) and compares against
/// reference outputs captured from a trusted run of the same serving stack.
///
/// Honesty notes (see SPEC §9):
/// - Greedy outputs can legitimately differ across backends/quantizations. References MUST be
///   captured from the same stack hosts run (our pinned host-runner image). Cross-stack
///   mismatches are a signal, not proof — hence battery + threshold + consecutive-round policy.
/// - Transport errors are inconclusive (excluded from score), never failures. A down host is
///   a liveness problem (health.ts), not an identity problem.
/// - Probes + references are public: anyone can re-run verification. Don't trust, re-run.

export interface Probe {
  id: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
}

/// @notice Short, greedy-stable, family-discriminating prompts. Keep maxTokens tiny: probes are paid calls.
export const PROBES: Probe[] = [
  {
    id: "cap-france",
    messages: [{ role: "user", content: "Complete with exactly the city name and nothing else: The capital of France is" }],
    maxTokens: 8,
  },
  {
    id: "arith",
    messages: [{ role: "user", content: "Reply with only the number, no other text: 17 + 25 =" }],
    maxTokens: 8,
  },
  {
    id: "repeat",
    messages: [{ role: "user", content: "Repeat this exactly, nothing else: blue seven quiet" }],
    maxTokens: 12,
  },
  {
    id: "backwards",
    messages: [{ role: "user", content: "Write the word 'hello' backwards, letters only, nothing else:" }],
    maxTokens: 8,
  },
  {
    id: "month",
    messages: [{ role: "user", content: "Reply with only the word: the month after June is" }],
    maxTokens: 8,
  },
];

export const VERIFY_SEED = 42;

/// @notice Normalize before comparing: case/whitespace/punctuation drift is not identity drift.
export function normalizeCompletion(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.?!,:;]+$/g, "");
}

export function scoreProbe(got: string, expected: string): boolean {
  return normalizeCompletion(got) === normalizeCompletion(expected);
}

export interface ProbeTarget {
  address: string;
  endpoint: string;
  modelId: string;
}

export interface ProbeResult {
  probeId: string;
  match: boolean;
  expected: string;
  got: string;
  error?: string;
}

export interface CheckReport {
  host: string;
  modelId: string;
  ts: number;
  passed: number;
  total: number;
  score: number | null; // null when inconclusive (all probes errored)
  inconclusive: boolean;
  results: ProbeResult[];
}

function extractContent(out: unknown): string {
  const c = (out as any)?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

/// @notice Run the battery against one host via `send` — the gateway passes its PAID
/// sender (proxyWithFallback path), so probes are paid calls like any other traffic:
/// the host earns, receipts log, nothing is hidden. Tests pass a stub.
export async function spotCheck(
  target: ProbeTarget,
  send: (body: unknown) => Promise<unknown>,
  probes: Probe[],
  references: Record<string, string>,
  opts: { model?: string; seed?: number } = {},
): Promise<CheckReport> {
  const model = opts.model ?? target.modelId;
  const seed = opts.seed ?? VERIFY_SEED;
  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const expected = references[probe.id];
    if (expected === undefined) continue;
    try {
      const out = await send({
        model,
        messages: probe.messages,
        temperature: 0,
        seed,
        max_tokens: probe.maxTokens,
        stream: false,
      });
      const got = extractContent(out);
      results.push({ probeId: probe.id, match: scoreProbe(got, expected), expected, got });
    } catch (e) {
      results.push({ probeId: probe.id, match: false, expected, got: "", error: String(e) });
    }
  }
  const conclusive = results.filter((r) => !r.error);
  const passed = conclusive.filter((r) => r.match).length;
  return {
    host: target.address,
    modelId: target.modelId,
    ts: Date.now(),
    passed,
    total: conclusive.length,
    score: conclusive.length ? passed / conclusive.length : null,
    inconclusive: conclusive.length === 0,
    results,
  };
}

export interface VerifyPolicy {
  threshold: number; // score below this fails a round
  consecutive: number; // failing rounds in a row before the host is failing
}

export const DEFAULT_POLICY: VerifyPolicy = { threshold: 0.6, consecutive: 3 };

/// @notice failing = last `consecutive` CONCLUSIVE reports all below threshold.
/// A single bad round never convicts; inconclusive rounds pause the streak.
export function isFailing(reports: CheckReport[], policy: VerifyPolicy = DEFAULT_POLICY): boolean {
  const conclusive = reports.filter((r) => !r.inconclusive).slice(-policy.consecutive);
  return (
    conclusive.length === policy.consecutive &&
    conclusive.every((r) => (r.score ?? 1) < policy.threshold)
  );
}

export interface VerifySummary {
  lastCheck: number | null;
  checks: number;
  avgScore: number | null; // over conclusive reports in window
  failing: boolean;
}

/// @notice Rolling per-host verification history (in-memory, like MemoryHealth).
export class MemoryVerifier {
  private history = new Map<string, CheckReport[]>();

  constructor(
    private window = 10,
    private policy: VerifyPolicy = DEFAULT_POLICY,
  ) {}

  record(report: CheckReport): void {
    const key = report.host.toLowerCase();
    const list = [...(this.history.get(key) ?? []), report].slice(-this.window);
    this.history.set(key, list);
  }

  reports(address: string): CheckReport[] {
    return this.history.get(address.toLowerCase()) ?? [];
  }

  verification(address: string): VerifySummary {
    const list = this.reports(address);
    const conclusive = list.filter((r) => !r.inconclusive);
    return {
      lastCheck: list.length ? list[list.length - 1].ts : null,
      checks: list.length,
      avgScore: conclusive.length
        ? conclusive.reduce((a, r) => a + (r.score ?? 0), 0) / conclusive.length
        : null,
      failing: isFailing(list, this.policy),
    };
  }

  /// @notice 0..1 multiplier for the scorer. Unchecked hosts route normally (null-safe).
  scoreMultiplier(address: string): number {
    const v = this.verification(address);
    if (v.avgScore === null) return 1;
    if (v.failing) return 0;
    return 0.5 + 0.5 * Math.min(1, Math.max(0, v.avgScore));
  }
}
