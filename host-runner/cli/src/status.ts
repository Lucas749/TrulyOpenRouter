import { execFile } from "child_process";
import { loadConfig } from "./config.js";

function sh(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || stderr).slice(0, 400) });
    });
  });
}

export async function status(): Promise<void> {
  const cfg = loadConfig();
  console.log(`gateway:  ${cfg.gateway || "(not logged in — run tor-host login)"}`);
  console.log(`account:  ${cfg.userId ?? "—"}`);
  console.log(`host key: ${cfg.hostKey ? cfg.hostAddress ?? "(set)" : "—"}`);
  const docker = await sh("docker", ["info", "--format", "{{.ServerVersion}}"]);
  console.log(`docker:   ${docker.ok ? docker.out.trim() : "NOT FOUND — install Docker Desktop first"}`);
  if (!cfg.gateway) return;
  try {
    const s: any = await (await fetch(`${cfg.gateway}/api/stats`)).json();
    console.log(`network:  ${s.hostsOnline ?? "?"} hosts online · ${s.requests24h ?? "?"} calls/24h`);
    if (cfg.hostAddress) {
      const h: any = await (await fetch(`${cfg.gateway}/api/hosts/${cfg.hostAddress}`)).json();
      console.log(`my host:  ${h.active ? "serving" : "offline"} · ${h.calls24h ?? 0} calls/24h · earnings ${h.earningsWei ?? "—"}`);
    }
  } catch {
    console.log("network:  gateway unreachable");
  }
}
