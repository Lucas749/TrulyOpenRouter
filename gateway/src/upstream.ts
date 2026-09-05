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
  // endpoint = OpenAI baseURL (…/v1 or bare host: both normalize to …/v1/chat/completions,
  // covering Ollama :11434 and LM-Studio :1234/v1 layouts).
  const base = endpoint.replace(/\/+$/, "");
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upstream ${res.status} at ${url}`);
  return res.json();
}
