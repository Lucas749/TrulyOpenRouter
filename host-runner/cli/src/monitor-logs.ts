import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config.js";
import { sh } from "./util.js";

export const LOG_SOURCES = ["guard", "ollama", "tunnel", "setup"] as const;
export type LogSource = typeof LOG_SOURCES[number];
export interface LogFiles { tunnel?: string; setup?: string }

export function rememberLogFiles(files: LogFiles): void {
  if (!files.tunnel && !files.setup) return;
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  let previous: LogFiles = {};
  try { previous = JSON.parse(readFileSync(join(configDir(), "monitor.json"), "utf8")); } catch {}
  const next = {
    tunnel: files.tunnel ? resolve(files.tunnel) : previous?.tunnel,
    setup: files.setup ? resolve(files.setup) : previous?.setup,
  };
  writeFileSync(join(configDir(), "monitor.json"), JSON.stringify(next), { mode: 0o600 });
}

export async function collectLog(source: LogSource, signal?: AbortSignal): Promise<string[]> {
  if (source === "guard" || source === "ollama") {
    const compose = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docker-compose.yml");
    const result = await sh("docker", ["compose", "-f", compose, "logs", "--no-color", "--tail", "60", source], { timeoutMs: 4000, maxOut: 20000, signal });
    if (!result.ok) return ["Service logs unavailable. Check Docker and the service on the Overview tab."];
    return result.out ? result.out.split(/\r?\n/).slice(-80) : ["No service logs yet."];
  }
  let fd: number | undefined;
  try {
    const files = JSON.parse(readFileSync(join(configDir(), "monitor.json"), "utf8")) as LogFiles;
    const path = files?.[source];
    if (typeof path !== "string") return ["No log saved for this session. Quickstart saves the latest setup and tunnel logs."];
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return ["Log path is not a regular file."];
    const size = Math.min(stat.size, 20000);
    const buffer = Buffer.alloc(size);
    readSync(fd, buffer, 0, size, stat.size - size);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (stat.size > size) lines.shift();
    return lines.filter(Boolean).slice(-80);
  } catch {
    return ["This log is no longer available. Temporary logs may be removed after a restart."];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
