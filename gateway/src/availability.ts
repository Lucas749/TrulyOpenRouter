export interface HostAvailability {
  reachable: boolean;
  checkedAt: number;
  paymentMode: "x402" | "demo" | "unknown";
}

export class EndpointAvailability {
  private cache = new Map<string, { value: HostAvailability; expires: number }>();
  private pending = new Map<string, Promise<HostAvailability>>();
  constructor(private fetcher: typeof fetch = fetch, private ttlMs = 15000) {}

  async check(endpoint: string): Promise<HostAvailability> {
    const key = endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const probe = this.probe(key).then(value => {
      if (this.cache.size >= 2000) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, probe);
    return probe;
  }

  private async probe(endpoint: string): Promise<HostAvailability> {
    try {
      const response = await this.fetcher(`${endpoint}/health`, { signal: AbortSignal.timeout(4000), redirect: "error" });
      if (!response.ok) throw new Error("Guard unavailable");
      const body = await response.json() as { ok?: boolean; service?: string; payTo?: string };
      if (body.ok !== true || body.service !== "tor-guard") throw new Error("Not a healthy guard");
      return { reachable: true, checkedAt: Date.now(), paymentMode: body.payTo ? "x402" : "demo" };
    } catch {
      return { reachable: false, checkedAt: Date.now(), paymentMode: "unknown" };
    }
  }
}
