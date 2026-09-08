import { lookup as dnsLookup } from "dns/promises";
import { db } from "./db.js";

// IP-based host geo (no self-report needed). Free ip-api.com tier, no key,
// ~45 req/min — fine at our scale because results cache in host_meta.
// Display rule: geo first (observed), self-reported region as fallback.
// A host behind NAT/VPN shows its exit IP: still more honest than "—".

export interface GeoDeps {
  lookup?: (host: string) => Promise<string>;
  fetchFn?: typeof fetch;
}

export function ipOfEndpoint(endpoint: string): string | null {
  try {
    const host = new URL(endpoint).hostname;
    if (/^(\d+\.){3}\d+$/.test(host) || host.includes(":")) return host; // v4/v6 literal
    return null; // needs DNS below
  } catch {
    return null;
  }
}

export async function geoForEndpoint(endpoint: string, deps: GeoDeps = {}): Promise<string | null> {
  const lookup = deps.lookup ?? dnsLookup;
  const fetchFn = deps.fetchFn ?? fetch;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return null;
  }
  let ip = ipOfEndpoint(endpoint);
  if (!ip) {
    try {
      ip = (await lookup(host)).toString();
    } catch {
      return null;
    }
  }
  // Private/loopback exits tell nothing — skip rather than mislabel.
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|fc00:|fe80:)/i.test(ip)) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetchFn(`http://ip-api.com/json/${ip}?fields=status,countryCode,regionName`, { signal: ctl.signal });
      const d = (await r.json()) as any;
      if (d.status !== "success" || !d.countryCode) return null;
      return `${String(d.countryCode).toLowerCase()}-${String(d.regionName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown"}`;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

/// @notice Cached geo for a host address: fresh lookup only when nothing stored.
export async function cachedGeo(
  address: string,
  endpoint: string,
  store: { geoOf(a: string): Promise<string | null>; setGeo(a: string, geo: string): Promise<void> },
  deps: GeoDeps = {},
): Promise<string | null> {
  const hit = await store.geoOf(address).catch(() => null);
  if (hit) return hit;
  const geo = await geoForEndpoint(endpoint, deps);
  if (geo) await store.setGeo(address, geo).catch(() => {});
  return geo;
}
