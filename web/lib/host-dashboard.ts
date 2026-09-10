const GATEWAY = "/api/gw";
const requestSignal = (signal?: AbortSignal) => AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const CLAIM_KEY = "tor-my-hosts";

export interface HostDetail {
  address: string;
  registry: string | null;
  endpoint: string;
  modelId: string;
  active: boolean;
  stake: string | null;
  earningsWei: string | null;
  pricePerReq: string | null;
  pricePer1kTokens: string | null;
  calls24h: number;
  fail24h: number;
  lastHeartbeat: number | null;
  region: string | null;
  geo: string | null;
  reliability: number | null;
  challenged: boolean;
  tokensRecent: number;
}

export type HostEntry =
  | { address: string; status: "ready"; host: HostDetail }
  | { address: string; status: "pending" | "error"; message: string };

export interface HostDashboard {
  entries: HostEntry[];
  notice: string | null;
  updatedAt: number;
}

export function hostAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((a): a is string => typeof a === "string" && ADDRESS.test(a)).map((a) => a.toLowerCase()))];
}

export function storedHosts(): string[] {
  try { return hostAddresses(JSON.parse(localStorage.getItem(CLAIM_KEY) ?? "[]")); }
  catch { return []; }
}

export function storeHosts(addresses: string[]): void {
  localStorage.setItem(CLAIM_KEY, JSON.stringify(hostAddresses(addresses)));
}

const amount = (value: unknown): string | null => typeof value === "string" && /^\d+$/.test(value) ? value : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function heartbeatMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value < 1e12 ? value * 1000 : value;
  return ms <= 8.64e15 ? ms : null;
}

export function hbarLabel(value: string | null): string {
  if (value === null || !/^\d+$/.test(value)) return "—";
  const units = BigInt(value);
  const base = BigInt(100_000_000);
  const fraction = (units % base).toString().padStart(8, "0").replace(/0+$/, "");
  return `${(units / base).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export async function loadHost(address: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<HostEntry> {
  try {
    const response = await fetchFn(`${GATEWAY}/api/hosts/${address}`, { signal: requestSignal(signal) });
    if (response.status === 404) return { address, status: "pending", message: "No active registration was found for this address. If you’re setting up this host, finish setup on its machine." };
    if (!response.ok) throw new Error("lookup failed");
    const d = await response.json();
    if (!d || typeof d.address !== "string" || d.address.toLowerCase() !== address.toLowerCase() || typeof d.modelId !== "string" || typeof d.active !== "boolean") throw new Error("invalid host");
    return { address, status: "ready", host: {
      address, registry: typeof d.registry === "string" && ADDRESS.test(d.registry) ? d.registry : null,
      endpoint: typeof d.endpoint === "string" ? d.endpoint : "", modelId: d.modelId, active: d.active,
      stake: amount(d.stake), earningsWei: amount(d.earningsWei), pricePerReq: amount(d.pricePerReq), pricePer1kTokens: amount(d.pricePer1kTokens),
      calls24h: count(d.calls24h), fail24h: count(d.fail24h), lastHeartbeat: heartbeatMs(d.lastHeartbeat),
      region: typeof d.region === "string" ? d.region : null, geo: typeof d.geo === "string" ? d.geo : null,
      reliability: typeof d.reliability === "number" && Number.isFinite(d.reliability) ? Math.min(1, Math.max(0, d.reliability)) : null,
      challenged: d.challenged === true,
      tokensRecent: Array.isArray(d.receipts) ? d.receipts.reduce((n: number, r: { tokensIn?: unknown; tokensOut?: unknown } | null) => n + count(r?.tokensIn) + count(r?.tokensOut), 0) : 0,
    } };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { address, status: "error", message: "Host details are temporarily unavailable. Your link is saved; try refreshing." };
  }
}

export async function loadHostDashboard(userId: string | null, bookmarks: string[], signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<HostDashboard> {
  let addresses = hostAddresses(bookmarks);
  let notice: string | null = null;
  if (userId) {
    try {
      const response = await fetchFn(`${GATEWAY}/api/owners/${encodeURIComponent(userId)}/hosts`, { signal: requestSignal(signal) });
      if (!response.ok) throw new Error("owner lookup failed");
      const data = await response.json();
      if (!Array.isArray(data?.data)) throw new Error("invalid owner list");
      addresses = hostAddresses([...data.data, ...addresses]);
    } catch (error) {
      if (signal?.aborted) throw error;
      notice = "We couldn’t refresh your account’s hosts. Showing saved hosts for now.";
    }
  }
  return { entries: await Promise.all(addresses.map((address) => loadHost(address, signal, fetchFn))), notice, updatedAt: Date.now() };
}

export function totalHostAmount(entries: HostEntry[], field: "stake" | "earningsWei"): string | null {
  if (entries.some((e) => e.status !== "ready" || e.host[field] === null)) return null;
  return entries.reduce((sum, e) => sum + (e.status === "ready" ? BigInt(e.host[field]!) : BigInt(0)), BigInt(0)).toString();
}
