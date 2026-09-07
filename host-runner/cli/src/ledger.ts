import { execFile } from "child_process";
import { loadConfig } from "./config.js";
import { banner, box, ok, warn } from "./ui.js";

// Ledger operator surface (L1–L4 visibility in the terminal).
// Read-only unless you run `init`: no seeds, no passwords, no plaintext —
// key NAMES only, values never printed. The web mirror of this is /security.

export interface ExecRunner {
  run(args: string[]): Promise<{ ok: boolean; out: string }>;
}

export function cliRunner(): ExecRunner {
  return {
    run: (args) =>
      new Promise((resolve) => {
        execFile("wallet-cli", args, { timeout: 90000 }, (err, stdout, stderr) => {
          resolve({ ok: !err, out: String(stdout || stderr).trim().slice(0, 400) });
        });
      }),
  };
}

export interface LedgerState {
  cli: string; // wallet-cli version or "(missing)"
  device: "genuine" | "locked-or-absent" | "wrong-app";
  ring: "provisioned" | "absent" | "unknown";
  keys: string[]; // NAMES only
  passwordEnv: boolean; // WALLET_PASS present in this shell
}

export async function collectLedgerState(run: ExecRunner = cliRunner()): Promise<LedgerState> {
  const ver = await run.run(["--version"]);
  // v2.1+ prints JSON {"ok":true,"data":{...,"version":"2.1.0"}}; older prints bare text.
  let cli = "(install: npm i -g @ledgerhq/wallet-cli)";
  if (ver.ok) {
    try {
      cli = `v${JSON.parse(ver.out).data.version}`;
    } catch {
      cli = ver.out.split("\n")[0].slice(0, 24);
    }
  }
  let device: LedgerState["device"] = "locked-or-absent";
  if (ver.ok) {
    const g = await run.run(["genuine-check"]);
    device = g.ok && /genuine/i.test(g.out) ? "genuine" : /wrong app/i.test(g.out) ? "wrong-app" : "locked-or-absent";
  }
  let ring: LedgerState["ring"] = "unknown";
  let keys: string[] = [];
  if (process.env.WALLET_PASS) {
    const k = await run.run(["ring", "keys"]);
    if (k.ok) {
      ring = "provisioned";
      keys = k.out
        .split("\n")
        .map((l) => l.split(/\s{2,}|\t/)[0].trim())
        .filter((l) => l && l !== "Key" && !l.startsWith("─"));
    } else if (/not initialized/i.test(k.out)) {
      ring = "absent";
    }
  }
  return { cli, device, ring, keys, passwordEnv: !!process.env.WALLET_PASS };
}

export function renderLedgerState(s: LedgerState): string[] {
  const lines = [
    `cli:     ${s.cli}`,
    `device:  ${s.device === "genuine" ? "genuine ✓" : s.device === "wrong-app" ? "open the dashboard (a currency app is open)" : "not seen — plug in, unlock, stay on dashboard"}`,
    `ring:    ${s.ring === "provisioned" ? `provisioned ✓ (${s.keys.length} key${s.keys.length === 1 ? "" : "s"})` : s.ring === "absent" ? "absent — run: tor-host ledger init" : "unknown (no WALLET_PASS in env)"}`,
  ];
  for (const k of s.keys) lines.push(`  key:    ${k}`);
  if (!s.passwordEnv) lines.push(`env:     WALLET_PASS missing — ring commands need it (keychain substitution, never paste it)`);
  return lines;
}

export async function ledgerStatus(): Promise<void> {
  console.log(banner());
  const s = await collectLedgerState();
  console.log(box("Ledger", renderLedgerState(s)));
  if (s.device === "genuine" && s.ring === "provisioned") console.log(ok("device-backed trust live — secrets in ring, taps on /security"));
  else console.log(warn("setup: tor-host ledger init (device + one tap)"));
}

export async function ledgerInit(): Promise<void> {
  console.log(banner());
  const run = cliRunner();
  const ver = await run.run(["--version"]);
  if (!ver.ok) throw new Error("wallet-cli missing — run: npm i -g @ledgerhq/wallet-cli");
  console.log("1/3  checking device (stay on the dashboard)…");
  const g = await run.run(["genuine-check"]);
  if (!g.ok || !/genuine/i.test(g.out)) throw new Error(`device not ready: ${g.out.slice(0, 120)} — unlock, open dashboard, retry`);
  console.log(ok("device genuine"));
  if (!process.env.WALLET_PASS) {
    throw new Error("WALLET_PASS missing — store it once: security add-generic-password -a default -s ledger-wallet-cli -w, then re-run with WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w)");
  }
  console.log("2/3  password present (from env, never shown)…");
  console.log("3/3  provisioning ring — approve ONCE on the device…");
  console.log("     (needs the Ledger Sync app installed+enabled first — see LEDGER-WALKTHROUGH)");
  const init = await run.run(["ring", "init"]);
  if (!init.ok) throw new Error(`ring init failed: ${init.out.slice(0, 200)}`);
  console.log(ok("key ring provisioned — device can live in a drawer now"));
}

export async function ledgerTaps(gateway: string, token: string): Promise<void> {
  console.log(banner());
  const r = await fetch(`${gateway}/api/admin/taps?status=pending`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401) throw new Error("bad admin token");
  if (r.status === 501) throw new Error("tap queue not configured on this gateway");
  const d: any = await r.json();
  const taps: any[] = d.taps ?? [];
  if (!taps.length) {
    console.log(box("Taps", ["queue empty — nothing needs your Ledger"]));
    return;
  }
  const lines = taps.flatMap((t: any) => {
    const approve =
      typeof t.approveAmountTinybar === "number"
        ? `send exactly ${(t.approveAmountTinybar / 1e8).toString()} HBAR to yourself (Ledger Live, HBAR app)`
        : "legacy tap (pre-Hedera schema) — requeue it, then approve";
    return [
      `${t.id} [${t.kind}] — ${t.status}`,
      `  approve: ${approve}`,
      `  then:    curl -X POST ${gateway}/api/admin/taps/${t.id}/verify -H "Authorization: Bearer $TOKEN"`,
    ];
  });
  console.log(box(`Taps (${taps.length} pending)`, lines));
}

export async function ledgerCmd(sub: string | undefined, rest: string[]): Promise<void> {
  const flag = (name: string, def?: string) => {
    const eq = rest.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
    if (eq !== undefined) return eq;
    const i = rest.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < rest.length && !rest[i + 1].startsWith("--")) return rest[i + 1];
    return def;
  };
  if (sub === "init") return ledgerInit();
  if (sub === "taps") {
    const gw = flag("gateway") ?? loadConfig().gateway ?? "http://127.0.0.1:4121";
    const token = flag("token") ?? process.env.GATEWAY_ADMIN_TOKEN ?? "";
    if (!token) throw new Error("needs --token or GATEWAY_ADMIN_TOKEN env");
    return ledgerTaps(gw, token);
  }
  return ledgerStatus();
}
