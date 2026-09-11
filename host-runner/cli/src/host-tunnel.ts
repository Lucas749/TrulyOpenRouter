import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { configDir } from "./config.js";
import { rememberLogFiles } from "./monitor-logs.js";
import { sh } from "./util.js";

interface Tunnel { pid: number; identity: string; log: string }
const file = () => join(configDir(), "tunnel.json");
function stored(): Tunnel | null { try { return JSON.parse(readFileSync(file(), "utf8")); } catch { return null; } }
async function identity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  const result = await sh("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { timeoutMs: 3000 });
  return result.ok && /cloudflared tunnel --url http:\/\/127\.0\.0\.1:4122(?:\s|$)/.test(result.out) ? result.out : null;
}

export async function rememberTunnel(pid: number, log: string): Promise<void> {
  const fingerprint = await identity(pid);
  if (!fingerprint) throw new Error("The tunnel process is no longer running.");
  const previous = stored();
  if (previous && previous.pid !== pid) await stopTunnel();
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify({ pid, identity: fingerprint, log }), { mode: 0o600 });
  rememberLogFiles({ tunnel: log });
}

export async function stopTunnel(): Promise<void> {
  const tunnel = stored();
  if (!tunnel || await identity(tunnel.pid) !== tunnel.identity) return;
  try { process.kill(tunnel.pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  for (let i = 0; i < 30; i++) {
    if (await identity(tunnel.pid) !== tunnel.identity) return;
    await wait(100);
  }
  throw new Error("Tunnel is still stopping. Retry shutdown in a moment.");
}

export async function healthyGuard(endpoint: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/health`, { signal: AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]) });
    const body = await response.json();
    return response.ok && body.ok === true && body.service === "tor-guard";
  } catch { return false; }
}

export async function ensureTunnel(endpoint: string, signal?: AbortSignal): Promise<string> {
  if (await healthyGuard(endpoint, signal)) return endpoint;
  if (!new URL(endpoint).hostname.endsWith(".trycloudflare.com")) throw new Error("Your public endpoint is unreachable. Restore its tunnel or use tor-host run --endpoint URL.");
  signal?.throwIfAborted();
  await stopTunnel();
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const log = join(configDir(), `tunnel-${Date.now()}.log`);
  const fd = openSync(log, "w", 0o600);
  const child = spawn("cloudflared", ["tunnel", "--url", "http://127.0.0.1:4122"], { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; });
  child.unref();
  try {
    for (let i = 0; i < 45; i++) {
      await wait(1000, undefined, { signal });
      if (spawnError) throw new Error("Could not start cloudflared. Install it, then retry Start.");
      const url = readFileSync(log, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
      if (url && await healthyGuard(url, signal)) {
        await rememberTunnel(child.pid!, log);
        return url;
      }
      if (child.exitCode !== null) throw new Error("Tunnel exited. See the tunnel log and retry Start.");
    }
    throw new Error("Tunnel did not become reachable. Check the tunnel log and retry Start.");
  } catch (error) {
    child.kill("SIGTERM"); rememberLogFiles({ tunnel: log }); throw error;
  }
}
