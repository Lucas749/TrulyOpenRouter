import type { HostInfo } from "./registry.js";
import { rankHosts } from "./score.js";

export interface Upstream {
  host: HostInfo | null;
  endpoint: string;
}

/// @notice Best ranked host for the model, else configured fallback (local dev), else throw.
export async function selectUpstream(
  modelId: string,
  fetchHosts: () => Promise<HostInfo[]>,
  fallback?: string,
): Promise<Upstream> {
  const ranked = rankHosts((await fetchHosts()).filter((h) => h.modelId === modelId));
  if (ranked.length > 0) return { host: ranked[0], endpoint: ranked[0].endpoint };
  if (!fallback) throw new Error(`no hosts for model ${modelId}`);
  return { host: null, endpoint: fallback };
}

export async function proxyChat(
  endpoint: string,
  body: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchFn(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upstream ${res.status} at ${endpoint}`);
  return res.json();
}
