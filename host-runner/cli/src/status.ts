import { execFile } from "child_process";
import { loadConfig } from "./config.js";
import { banner, box, ok, warn } from "./ui.js";
import { formatVerification } from "./verify.js";

function sh(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || stderr).trim().slice(0, 120) });
    });
  });
}

export async function status(): Promise<void> {
  console.log(banner());
  const cfg = loadConfig();
  const lines: string[] = [`gateway:  ${cfg.gateway || "(not logged in — tor-host login)"}`, `account:  ${cfg.userId ?? "—"}`, `host key: ${cfg.hostKey ? (cfg.hostAddress ?? "(set)") : "—"}`];
  const docker = await sh("docker", ["info", "--format", "{{.ServerVersion}}"]);
  lines.push(docker.ok ? `docker:   ${docker.out}` : "docker:   NOT FOUND — install Docker Desktop first");
  if (cfg.gateway) {
    try {
      const s: any = await (await fetch(`${cfg.gateway}/api/stats`)).json();
      lines.push(`network:  ${s.hostsOnline ?? "?"} hosts online · ${s.requests24h ?? "?"} calls/24h`);
      if (cfg.hostAddress) {
        const h: any = await (await fetch(`${cfg.gateway}/api/hosts/${cfg.hostAddress}`)).json();
        lines.push(`my host:  ${h.active ? "serving" : "offline"} · ${h.calls24h ?? 0} calls/24h · earnings ${h.earningsWei ?? "—"}`);
        lines.push(`${formatVerification(h.verification)}${h.challenged ? " · CHALLENGED — under review" : ""}`);
      }
    } catch {
      lines.push("network:  gateway unreachable");
    }
  }
  console.log(box("Status", lines));
  if (!cfg.gateway) console.log(warn("start with: tor-host login --gateway=http://HOST:4121"));
  else console.log(ok("all systems nominal"));
}
