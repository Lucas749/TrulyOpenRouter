import { loadConfig } from "./config.js";
import { sh } from "./util.js";

export type Reading<T> = { state: "ok"; data: T } | { state: "missing" | "unavailable"; message: string };
export interface Receipt {
  id: string; ts: number; modelId: string; tokensIn: number | null; tokensOut: number | null; latencyMs: number | null;
}
export interface Host {
  address: string; modelId: string; endpoint: string; active: boolean;
  region: string | null; stake: string | null; earnings: string | null;
  requests24h: number | null; requests7d: number | null; failures24h: number | null;
  latencyMs: number | null; reliability: number | null; heartbeat: number | null;
  priceReq: string | null; price1k: string | null; verification: string; failing: boolean;
  receipts: Receipt[];
}
export interface Model { name: string; size: number | null; parameters: string | null; quantization: string | null }
export interface Guard { paid: boolean }
export interface MonitorSnapshot {
  at: number;
  gateway: string; address: string | null; linked: boolean;
  docker: Reading<string>;
  guard: Reading<Guard>;
  endpoint: Reading<Guard>;
  models: Reading<Model[]>;
  loaded: Reading<string[]>;
  host: Reading<Host>;
  network: Reading<Host[]>;
}
export interface MonitorOptions { gateway?: string; guardUrl?: string; ollamaUrl?: string }
type RecordData = Record<string, unknown>;
const record = (value: unknown): RecordData => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordData : {};
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const amount = (value: unknown): string | null => typeof value === "string" && /^\d+$/.test(value) ? value : null;
const missing = <T>(message: string): Reading<T> => ({ state: "missing", message });
const unavailable = <T>(message: string): Reading<T> => ({ state: "unavailable", message });

export function parseHost(value: unknown): Host {
  const d = record(value);
  if (typeof d.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(d.address) || typeof d.modelId !== "string" || typeof d.active !== "boolean") throw new Error("invalid host response");
  const verification = record(d.verification);
  const heartbeat = count(d.lastHeartbeat);
  const receipts = (Array.isArray(d.receipts) ? d.receipts : []).map(record).filter(r => typeof r.id === "string" && count(r.ts) !== null).map(r => ({
    id: String(r.id), ts: Number(r.ts), modelId: str(r.modelId) ?? d.modelId as string,
    tokensIn: count(r.tokensIn), tokensOut: count(r.tokensOut), latencyMs: count(r.latencyMs),
  })).sort((a, b) => b.ts - a.ts).slice(0, 20);
  return {
    address: d.address, modelId: d.modelId, endpoint: str(d.endpoint) ?? "", active: d.active,
    region: str(d.geo) ?? str(d.region), stake: amount(d.stake), earnings: amount(d.earningsWei),
    requests24h: count(d.calls24h), requests7d: count(d.calls7d), failures24h: count(d.fail24h),
    latencyMs: count(d.latencyMs), reliability: count(d.reliability),
    heartbeat: heartbeat === null ? null : heartbeat < 1e12 ? heartbeat * 1000 : heartbeat,
    priceReq: amount(d.pricePerReq), price1k: amount(d.pricePer1kTokens),
    verification: verification.failing === true ? "Failing · out of rotation" : Number(verification.checks) > 0 ? "Passed" : "Not checked yet",
    failing: verification.failing === true, receipts,
  };
}

export function parseModels(value: unknown): Model[] {
  const data = record(value);
  if (!Array.isArray(data.models)) throw new Error("invalid model response");
  return data.models.map(record).filter(m => typeof m.name === "string").map(m => ({
    name: String(m.name), size: count(m.size), parameters: str(record(m.details).parameter_size), quantization: str(record(m.details).quantization_level),
  }));
}

function guardHealth(value: unknown): Guard {
  const d = record(value);
  if (d.ok !== true || d.service !== "tor-guard") throw new Error("unexpected health response");
  return { paid: typeof d.payTo === "string" && d.payTo.length > 0 };
}

async function read<T>(url: string, parse: (data: unknown) => T, fetchFn: typeof fetch, signal?: AbortSignal): Promise<Reading<T>> {
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return unavailable("Invalid service URL");
    const res = await fetchFn(u, { signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) });
    if (res.status === 404) return missing("Not found");
    if (!res.ok) return unavailable(`HTTP ${res.status}`);
    return { state: "ok", data: parse(await res.json()) };
  } catch {
    return unavailable(signal?.aborted ? "Refresh cancelled" : "Unreachable or invalid response");
  }
}

export async function collectMonitor(
  options: MonitorOptions = {}, signal?: AbortSignal,
  deps = { config: loadConfig, fetch: fetch, shell: sh, now: Date.now },
): Promise<MonitorSnapshot> {
  const cfg = deps.config();
  const gateway = (options.gateway ?? cfg.gateway ?? "").replace(/\/+$/, "");
  const address = /^0x[0-9a-fA-F]{40}$/.test(cfg.hostAddress ?? "") ? cfg.hostAddress! : null;
  const ollama = (options.ollamaUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const guard = (options.guardUrl ?? "http://127.0.0.1:4122").replace(/\/+$/, "");
  const [docker, localGuard, models, loaded, host, network] = await Promise.all([
    deps.shell("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 4000 }).then(async d => {
      if (d.ok) return { state: "ok" as const, data: d.out };
      const cli = await deps.shell("docker", ["--version"], { timeoutMs: 2000 });
      return cli.ok ? unavailable<string>("Engine stopped or unreachable · start Docker") : missing<string>("Docker CLI missing · install Docker Desktop");
    }),
    read(`${guard}/health`, guardHealth, deps.fetch, signal),
    read(`${ollama}/api/tags`, parseModels, deps.fetch, signal),
    read(`${ollama}/api/ps`, d => parseModels(d).map(m => m.name), deps.fetch, signal),
    gateway && address ? read(`${gateway}/api/hosts/${address}`, d => {
      const h = parseHost(d);
      if (h.address.toLowerCase() !== address.toLowerCase()) throw new Error("host address mismatch");
      return h;
    }, deps.fetch, signal) : missing<Host>(address ? "Set a gateway with tor-host login" : "No host key yet · run quickstart"),
    gateway ? read(`${gateway}/api/hosts`, d => {
      const data = record(d);
      if (!Array.isArray(data.data)) throw new Error("invalid directory response");
      return data.data.map(parseHost);
    }, deps.fetch, signal) : missing<Host[]>("No gateway configured"),
  ]);
  const endpoint = host.state === "ok" && host.data.endpoint
    ? await read(`${host.data.endpoint.replace(/\/+$/, "")}/health`, guardHealth, deps.fetch, signal)
    : missing<Guard>("No registered endpoint to check");
  // Only public identity and telemetry leave this collector. Never copy keys or tokens.
  return { at: deps.now(), gateway, address, linked: Boolean(cfg.userId), docker, guard: localGuard, endpoint, models, loaded, host, network };
}

export function modelAvailable(models: Model[], id: string): boolean {
  return models.some(m => m.name === id || (!id.includes(":") && m.name === `${id}:latest`));
}

export function servingState(s: MonitorSnapshot): { tone: "good" | "warn" | "bad"; title: string; detail: string } {
  if (!s.address) return { tone: "warn", title: "Setup needed", detail: "Finish quickstart to register this machine." };
  if (s.host.state === "missing") return { tone: "warn", title: "Not listed", detail: "The gateway has no active registration for this host key." };
  if (s.host.state !== "ok") return { tone: "warn", title: "Status unavailable", detail: "Host lookup failed. Request counts and earnings are unknown." };
  if (!s.host.data.active) return { tone: "warn", title: "Inactive", detail: "This host is not active in the registry." };
  if (s.host.data.failing) return { tone: "bad", title: "Out of rotation", detail: "The model check is failing. Review the model and service logs." };
  if (s.guard.state !== "ok") return { tone: "bad", title: "Local guard offline", detail: "The payment guard on this machine did not pass its health check." };
  if (s.models.state !== "ok") return { tone: "warn", title: "Model status unavailable", detail: "Ollama is unreachable. Check its service on the Logs tab." };
  if (!modelAvailable(s.models.data, s.host.data.modelId)) return { tone: "bad", title: "Model missing", detail: `Ollama does not have the registered model ${s.host.data.modelId}.` };
  if (s.endpoint.state !== "ok") return { tone: "bad", title: "Public endpoint unreachable", detail: "Local services are ready, but the registered URL did not pass its health check. Check the tunnel." };
  const recent = s.host.data.receipts[0];
  if (recent && s.at - recent.ts < 300_000) return { tone: "good", title: "Serving · recent traffic", detail: "A routed request completed in the last five minutes. All readiness checks pass." };
  return { tone: "good", title: "Ready to serve", detail: "Registered, model available, public guard reachable. Waiting for requests." };
}

export function decimalAmount(value: string | null, decimals: number): string {
  if (value === null || !/^\d+$/.test(value)) return "—";
  const units = BigInt(value), base = 10n ** BigInt(decimals);
  const fraction = (units % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(units / base).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
