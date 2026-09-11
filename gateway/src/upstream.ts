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

/// @notice Canonical chat URL for any OpenAI base (Ollama :11434 and LM-Studio :1234/v1 layouts).
export function chatUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
}

export async function proxyChat(
  endpoint: string,
  body: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const url = chatUrl(endpoint);
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new UpstreamError(res.status, url);
  return res.json();
}

export class UpstreamError extends Error {
  status: number;
  url: string;

  constructor(status: number, url: string) {
    super(`upstream ${status} at ${url}`);
    this.status = status;
    this.url = url;
  }
}

/// @notice Retry direct-gated hosts with a paid fetch ONLY on 402 and only when payer creds exist.
export function shouldPayRetry(e: unknown, hasPayer: boolean): boolean {
  return hasPayer && e instanceof UpstreamError && e.status === 402;
}

export interface X402Creds {
  accountId: string;
  privateKey: string;
}

/// @notice Direct first; paid x402 retry only when the host gates (402) and creds exist.
/// paidFetch is injected (createPaidFetch in prod, stub in tests).
export async function proxyWithFallback(
  endpoint: string,
  body: unknown,
  x402: X402Creds | undefined,
  paidFetch: typeof fetch | undefined,
  onPaying?: () => void,
  fetchFn: typeof fetch = fetch,
): Promise<{ out: unknown; paid: boolean; x402Transaction?: string }> {
  try {
    return { out: await proxyChat(endpoint, body, fetchFn), paid: false };
  } catch (e) {
    if (!shouldPayRetry(e, !!x402) || !paidFetch) throw e;
    onPaying?.();
    const res = await paidFetch(chatUrl(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new UpstreamError(res.status, chatUrl(endpoint));
    let x402Transaction: string | undefined;
    try {
      const header = res.headers?.get("payment-response");
      const payment = header && header.length < 8192 ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null;
      if (payment?.success === true && payment.network === "hedera:testnet" && typeof payment.transaction === "string" && payment.transaction.length < 200) {
        x402Transaction = payment.transaction;
      }
    } catch { /* Missing payment metadata must not discard a completed response. */ }
    return { out: await res.json(), paid: true, ...(x402Transaction ? { x402Transaction } : {}) };
  }
}
