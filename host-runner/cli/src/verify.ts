import { loadConfig } from "./config.js";
import { banner, err, ok, Spinner, warn } from "./ui.js";

export interface VerifySummary {
  lastCheck: number | null;
  checks: number;
  avgScore: number | null;
  failing: boolean;
}

export function formatAge(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/// @notice One-line verification state for status boxes. Pure, tested.
export function formatVerification(v: VerifySummary | null | undefined, now = Date.now()): string {
  if (!v || v.checks === 0 || v.avgScore === null) return "model check: — unchecked";
  const pct = `${(v.avgScore * 100).toFixed(0)}%`;
  const age = v.lastCheck ? ` · ${formatAge(v.lastCheck, now)}` : "";
  if (v.failing) return `model check: FAILING ${pct} (${v.checks} checks${age}) — out of rotation`;
  return `model check: ✓ ${pct} (${v.checks} check${v.checks === 1 ? "" : "s"}${age})`;
}

/// @notice On-demand spot check against my host. Probes are paid calls; mismatches print
/// expected-vs-got so a misconfigured host (wrong model pulled) is obvious.
export async function verifyHost(gateway: string, address: string): Promise<void> {
  console.log(banner());
  const spin = new Spinner();
  try {
    spin.start("running fingerprint probes (paid calls)");
    const res = await fetch(`${gateway}/api/verify/${address}`, { method: "POST" });
    const report: any = await res.json();
    if (!res.ok) throw new Error(report.error?.message ?? `gateway ${res.status}`);
    spin.stop();
    if (report.inconclusive) {
      console.log(warn("inconclusive — host unreachable, not counted against it"));
      return;
    }
    console.log(
      report.score === 1
        ? ok(`model check ${report.passed}/${report.total} · ${report.modelId}`)
        : warn(`model check ${report.passed}/${report.total} · ${report.modelId}`),
    );
    for (const r of report.results ?? []) {
      if (r.error) {
        console.log(`  ? ${r.probeId} — error: ${String(r.error).slice(0, 80)}`);
      } else if (!r.match) {
        console.log(`  ✗ ${r.probeId} — expected ${JSON.stringify(r.expected)} got ${JSON.stringify(r.got)}`);
      } else {
        console.log(`  ✓ ${r.probeId}`);
      }
    }
    if (report.verification?.failing) console.log(err("FAILING — out of rotation until it recovers"));
  } catch (e) {
    spin.stop();
    throw e; // rendered once by index.ts
  }
}

export function myHostAddress(): string {
  const cfg = loadConfig();
  if (!cfg.hostAddress) throw new Error("nothing registered here — tor-host run first");
  return cfg.hostAddress;
}
