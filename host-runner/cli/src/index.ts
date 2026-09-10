#!/usr/bin/env node
import { BaseError } from "viem";
import { FundingRequiredError } from "./registration.js";
import { loadConfig } from "./config.js";
import { login } from "./login.js";
import { link } from "./link.js";
import { run } from "./run.js";
import { leave } from "./leave.js";
import { status } from "./status.js";
import { dashboard, type DashboardOptions } from "./dashboard.js";
import { ledgerCmd } from "./ledger.js";
import { flag as flagArg } from "./util.js";
import { myHostAddress, verifyHost } from "./verify.js";

const [, , cmd, ...rest] = process.argv;
const flag = (name: string, def?: string) => flagArg(rest, name, def);
const dashboardOptions = (): DashboardOptions => ({ gateway: flag("gateway"), guardUrl: flag("guard-url"), ollamaUrl: flag("ollama-url"), once: rest.includes("--once"), json: rest.includes("--json"), tunnel: flag("tunnel-log"), setup: flag("setup-log") });
const gateway = () => {
  const g = flag("gateway") ?? loadConfig().gateway ?? "";
  if (!g) throw new Error("no gateway — run: tor-host login --gateway=http://HOST:4121");
  return g;
};

try {
  if (cmd === "dashboard" || cmd === "tui" || (!cmd && process.stdin.isTTY && process.stdout.isTTY)) await dashboard(dashboardOptions());
  else if (cmd === "login") await login(flag("gateway") ?? "http://127.0.0.1:4121");
  else if (cmd === "ledger") await ledgerCmd(rest[0], rest.slice(1));
  else if (cmd === "status") {
    if (rest.includes("--watch")) await dashboard(dashboardOptions());
    else await status(dashboardOptions());
  }
  else if (cmd === "link") await link(gateway());
  else if (cmd === "verify") await verifyHost(gateway(), flag("address") ?? myHostAddress());
  else if (cmd === "leave") {
    const cfg = await (await fetch(`${gateway()}/api/config`)).json().catch(() => ({}));
    await leave({
      gateway: gateway(),
      rpcUrl: flag("rpc-url") ?? cfg.rpcUrl ?? "https://testnet.hashio.io/api",
      registry: flag("registry") ?? loadConfig().hostRegistry ?? cfg.registry ?? "",
      legacyRegistries: flag("registry") ? [] : [cfg.registry, ...(cfg.legacyRegistries ?? [])].filter(Boolean),
      vault: flag("vault") ?? cfg.vault ?? "",
      dryRun: rest.includes("--dry-run"),
    });
  } else if (cmd === "run") {
    const model = flag("model");
    if (!model) throw new Error("usage: tor-host run --model <id> [--price-req N] [--price-1k N] [--region slug] [--stake-hbar N] [--endpoint URL]");
    await run({
      gateway: gateway(),
      model,
      priceReq: flag("price-req"),
      price1k: flag("price-1k"),
      region: flag("region"),
      stakeHbar: flag("stake-hbar"),
      endpoint: flag("endpoint"),
      statusFile: flag("status-file"),
    });
    if (!flag("status-file") && !rest.includes("--no-dashboard") && process.stdin.isTTY && process.stdout.isTTY) await dashboard(dashboardOptions());
  } else {
    console.log("tor-host — serve open models on TrulyOpenRouter\n\n  tor-host                            open the host console\n  tor-host dashboard                  live status, activity, models, network, logs\n  tor-host status [--json|--watch]     snapshot or live console\n  tor-host login [--gateway=URL]       link this machine to your web account\n  tor-host run --model <id> [--price-req N] [--price-1k N] [--region slug] [--stake-hbar N]\n  tor-host link                       claim this host for your account\n  tor-host ledger [status|init|taps]    device + key-ring state, guided setup, tap queue\n  tor-host verify [--address 0x…]      fingerprint spot-check my host\n  tor-host leave [--dry-run]           deregister, withdraw, stop guard\n\n  Dashboard: --once, --gateway URL, --guard-url URL, --ollama-url URL\n  Run: --no-dashboard keeps sequential output after setup");
    if (cmd && !["help", "--help", "-h"].includes(cmd)) process.exitCode = 1;
  }
} catch (e) {
  const message = e instanceof FundingRequiredError ? e.message
    : e instanceof BaseError ? e.shortMessage : String((e as Error)?.message ?? e).split("\n")[0];
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
