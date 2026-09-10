import { stripVTControlCharacters } from "node:util";
import { decimalAmount, servingState, type MonitorSnapshot, type Reading } from "./monitor.js";
import { type LogSource } from "./monitor-logs.js";

export const TABS = ["Overview", "Activity", "Models", "Network", "Logs", "Help"] as const;
export interface ViewState { tab: number; scroll: number; refreshing: boolean; logSource: LogSource; logs: string[]; notice: string }

// External model names, URLs, and logs are data, never terminal instructions.
export function cleanText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? "").replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g, ""))
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:private[_ -]?key|hostKey|token|password)\s*[=:]\s*)\S+/gi, "$1[redacted]");
}
function cellWidth(char: string): number {
  const cp = char.codePointAt(0)!;
  if (/\p{Mark}/u.test(char) || cp === 0x200d || cp === 0xfe0f) return 0;
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || cp >= 0x20000) ? 2 : 1;
}
export const textWidth = (s: string): number => Array.from(cleanText(s)).reduce((n, c) => n + cellWidth(c), 0);
export function fit(value: unknown, width: number): string {
  const text = cleanText(value);
  if (textWidth(text) <= width) return text;
  let out = "", used = 0;
  for (const char of text) {
    const n = cellWidth(char);
    if (used + n > width - 1) break;
    out += char; used += n;
  }
  return width > 0 ? `${out}…` : "";
}
export function wrap(value: unknown, width: number): string[] {
  if (textWidth(cleanText(value)) <= width) return [cleanText(value)];
  const words = cleanText(value).split(/\s+/);
  const lines: string[] = []; let line = "";
  for (const word of words) {
    if (textWidth(`${line} ${word}`.trim()) > width && line) { lines.push(line); line = ""; }
    if (textWidth(word) > width) {
      let part = "";
      for (const char of word) {
        if (textWidth(part + char) > width) { lines.push(part); part = ""; }
        part += char;
      }
      line = part;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}
const number = (n: number | null | undefined): string => n === null || n === undefined ? "—" : n.toLocaleString("en-US");
const short = (s: string): string => s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
const time = (ts: number | null): string => ts !== null && Number.isFinite(ts) && Math.abs(ts) < 8.64e15 ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
const kv = (key: string, value: unknown): string => `${key.padEnd(20)} ${cleanText(value)}`;
function check<T>(label: string, reading: Reading<T>, detail: (data: T) => string): string {
  return `${reading.state === "ok" ? "✓" : "!"} ${label.padEnd(17)} ${reading.state === "ok" ? detail(reading.data) : reading.message}`;
}
function tableRow(values: unknown[], widths: number[]): string {
  return values.map((v, i) => { const s = fit(v, widths[i]); return s + " ".repeat(Math.max(0, widths[i] - textWidth(s))); }).join("  ").trimEnd();
}

export function viewLines(snapshot: MonitorSnapshot | null, state: ViewState, width: number): string[] {
  if (state.tab === 5) return [
    "YOUR HOST CONSOLE", "", "← / → or Tab       Switch tabs", "1–6                 Jump to a tab", "↑ / ↓, PgUp / PgDn   Scroll", "r / Enter           Refresh now", "l                   Switch log source on Logs", "d                   Open your web dashboard", "n                   Open the network explorer", "q / Ctrl+C          Close this view", "",
    "Closing this dashboard does not stop the model, guard, or tunnel.", "", "OTHER COMMANDS", "tor-host dashboard       Reopen this console", "tor-host status          Print one snapshot", "tor-host status --json   Export public telemetry", "tor-host login           Link your account", "tor-host verify          Run a paid model spot-check", "tor-host ledger status   Inspect your device setup", "tor-host leave --dry-run Preview unstaking and withdrawal", "", "Readiness checks use health endpoints. They do not send inference requests.",
  ].flatMap(line => wrap(line, width));
  if (state.tab === 4) return [
    `SERVICE LOGS · ${state.logSource}`, "l: guard → ollama → tunnel → setup", "", ...state.logs.flatMap(line => wrap(line, width)),
  ];
  if (!snapshot) return ["Checking your host…", "", "Reading the gateway and local services. You can switch tabs while this loads."];
  const s = snapshot, host = s.host.state === "ok" ? s.host.data : null;
  if (state.tab === 0) {
    const serving = servingState(s);
    return [
      `${serving.tone === "good" ? "●" : "!"} ${serving.title.toUpperCase()}`, ...wrap(serving.detail, width), "",
      kv("Model", host?.modelId ?? "—"), kv("Host", s.address ?? "Not configured"), kv("Location", host?.region ?? "Not reported"), "",
      kv("Requests · 24h", number(host?.requests24h)), kv("Requests · 7d", number(host?.requests7d)), kv("Failed · 24h", number(host?.failures24h)),
      kv("Available earnings", `${decimalAmount(host?.earnings ?? null, 8)} HBAR`), kv("Staked", `${decimalAmount(host?.stake ?? null, 8)} HBAR`),
      kv("Typical latency", host?.latencyMs === null || !host ? "—" : `${Math.round(host.latencyMs)} ms`),
      kv("Success rate · 24h", host?.reliability === null || !host ? "—" : `${(Math.min(1, host.reliability) * 100).toFixed(1)}%`), "",
      "READINESS", check("Docker", s.docker, d => `Running · ${d}`),
      check("Local guard", s.guard, d => `Healthy · ${d.paid ? "payments enabled" : "test mode · payment gate off"}`),
      check("Ollama", s.models, d => `Reachable · ${d.length} downloaded model${d.length === 1 ? "" : "s"}`),
      check("Registered URL", s.endpoint, () => "Healthy from this machine"),
      check("Gateway listing", s.host, h => h.active ? "Active registration" : "Inactive"),
      kv("Model check", host?.verification ?? "Unknown"), kv("Account", s.linked ? "Linked" : "Not linked · tor-host login"), "",
      "REGISTERED ENDPOINT", ...wrap(host?.endpoint || "—", width), "", "GATEWAY", ...wrap(s.gateway || "Not configured", width),
      "", "Health checks confirm readiness. Completed requests confirm routed traffic.",
    ];
  }
  if (state.tab === 1) {
    if (!host) return ["REQUEST ACTIVITY", "", "Request history is unavailable until the gateway can find this host."];
    const columns = width >= 90 ? [20, 25, 10, 10, 10] : [14, 16, 9, 8];
    return ["REQUEST ACTIVITY", `${number(host.requests24h)} completed / 24h · ${number(host.failures24h)} failed / 24h · ${number(host.requests7d)} completed / 7d`, "",
      ...(host.receipts.length ? [
        width >= 90 ? tableRow(["TIME (UTC)", "MODEL", "TOKENS IN", "OUT", "LATENCY"], columns) : tableRow(["TIME (UTC)", "RECEIPT", "TOKENS", "LATENCY"], columns),
        ...host.receipts.map(r => width >= 90
          ? tableRow([time(r.ts).slice(0, 19), r.modelId, number(r.tokensIn), number(r.tokensOut), r.latencyMs === null ? "—" : `${Math.round(r.latencyMs)}ms`], columns)
          : tableRow([time(r.ts).slice(5, 19), short(r.id), r.tokensIn === null || r.tokensOut === null ? "—" : number(r.tokensIn + r.tokensOut), r.latencyMs === null ? "—" : `${Math.round(r.latencyMs)}ms`], columns)),
        "", "Latest 20 completed receipts from the gateway. Failed attempts have no receipt.",
      ] : ["No completed requests yet.", "", "Keep the model, guard, and tunnel running. Requests appear here as the gateway routes traffic to you."]),
    ].flatMap(line => wrap(line, width));
  }
  if (state.tab === 2) return [
    "YOUR MODELS", kv("Registered model", host?.modelId ?? "—"),
    kv("Price / request", host?.priceReq === null || !host ? "—" : `$${decimalAmount(host.priceReq, 8)}`),
    kv("Price / 1k tokens", host?.price1k === null || !host ? "—" : `$${decimalAmount(host.price1k, 8)}`), "", "DOWNLOADED IN OLLAMA", "",
    ...(s.models.state === "ok" ? s.models.data.length ? s.models.data.flatMap(m => [
      `${m.name}${m.name === host?.modelId ? "  [registered]" : ""}`,
      `  ${m.size === null ? "—" : `${(m.size / 1e9).toFixed(2)} GB`} · ${m.parameters ?? "unknown size"} · ${m.quantization ?? "unknown quantization"} · ${s.loaded.state !== "ok" ? "memory status unknown" : s.loaded.data.includes(m.name) ? "loaded in memory" : "on disk"}`,
      "",
    ]) : ["No downloaded models."] : [s.models.message]),
    "A model on disk can load on demand. Loaded in memory does not mean a request is running.",
  ].flatMap(line => wrap(line, width));
  if (state.tab === 3) {
    if (s.network.state !== "ok") return ["NETWORK", "", s.network.message, "Press r to retry."];
    const hosts = s.network.data;
    return ["NETWORK DIRECTORY", `${hosts.length} hosts listed · ${hosts.filter(h => h.active).length} registered active · ${new Set(hosts.map(h => h.modelId)).size} models`, "",
      ...hosts.flatMap(h => [
        `${h.address.toLowerCase() === s.address?.toLowerCase() ? "→ YOUR HOST" : short(h.address)} · ${h.modelId}`,
        `  ${h.region ?? "Location not reported"} · ${h.active ? "Registered" : "Inactive"} · ${number(h.requests24h)} requests / 24h`,
        `  ${h.failing ? "Model check failing" : `${number(h.failures24h)} failed / 24h`} · ${h.priceReq === null ? "—" : `$${decimalAmount(h.priceReq, 8)}`} / request`, "",
      ]),
      "Registration is directory state. Readiness checks on Overview cover your own host.",
    ].flatMap(line => wrap(line, width));
  }
  return [];
}

export function renderMonitor(snapshot: MonitorSnapshot | null, state: ViewState, columns = 100, rows = 30, color = true): string {
  const width = Math.max(1, columns - 4);
  const paint = (text: string, code: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const title = fit("TrulyOpenRouter  /  Host console", width);
  if (columns < 36 || rows < 10) return [title, "Resize for the full dashboard", "q: close"].slice(0, rows - 1).map(l => fit(l, columns - 1)).join("\r\n");
  const labels = width >= 85 ? TABS : ["Over", "Req", "Models", "Net", "Logs", "Help"];
  const tabs = width < 58 ? `${TABS[state.tab]} [${state.tab + 1}/6] · ←/→ switch tabs` : labels.map((name, i) => `${i + 1} ${i === state.tab ? `[${name}]` : name}`).join("  ");
  const header = [paint(title, "1"), fit(tabs, width), paint("─".repeat(width), "90")];
  const footer = [paint("─".repeat(width), "90"), fit(state.notice || `${state.refreshing ? "Refreshing…" : snapshot ? `Updated ${time(snapshot.at)}` : "Connecting…"} · auto-refresh 10s`, width), fit("←/→ tabs  ↑/↓ scroll  r refresh  d web  q close", width)];
  const height = Math.max(1, rows - header.length - footer.length - 1);
  const lines = viewLines(snapshot, state, width);
  const offset = Math.min(Math.max(0, state.scroll), Math.max(0, lines.length - height));
  const visible = lines.slice(offset, offset + height).map(l => fit(l, width));
  while (visible.length < height) visible.push("");
  if (lines.length > height && !state.notice) footer[1] = fit(`${state.refreshing ? "Refreshing…" : snapshot ? `Updated ${time(snapshot.at).slice(11)}` : "Connecting…"} · ${offset + 1}–${Math.min(offset + height, lines.length)} / ${lines.length} lines`, width);
  if (state.tab === 0 && snapshot) visible[0] = paint(visible[0], servingState(snapshot).tone === "good" ? "1;32" : "1;33");
  return [...header, ...visible, ...footer].map(l => `  ${l}`).join("\r\n");
}
