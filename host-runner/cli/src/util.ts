import { execFile } from "child_process";

// Shared CLI plumbing: shell-out, gateway fetch, --flag parsing.
// One home for the helpers previously copied across run/leave/status/login.

export function sh(cmd: string, args: string[], opts?: { timeoutMs?: number; maxOut?: number; signal?: AbortSignal }): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts?.timeoutMs ?? 30000, signal: opts?.signal }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || stderr).trim().slice(0, opts?.maxOut ?? 2000) });
    });
  });
}

export async function api(gateway: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${gateway}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export function flag(rest: string[], name: string, def?: string): string | undefined {
  const eq = rest.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  if (eq !== undefined) return eq;
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < rest.length && !rest[i + 1].startsWith("--")) return rest[i + 1];
  return def;
}
