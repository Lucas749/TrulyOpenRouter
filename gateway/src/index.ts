import express from "express";
import { createPublicClient, http, type Address } from "viem";
import { paymentMiddleware } from "@x402/express";
import { createResourceServer } from "./x402.js";
import { fetchEligibleHosts, type HostInfo } from "./registry.js";
import { issueKey, MemoryKeyStore, verifyKey, type KeyScopes } from "./keys.js";
import { buildReceipt, MemoryReceiptLog, sha256hex } from "./receipts.js";
import { proxyChat, selectUpstream } from "./upstream.js";
import { settleCall, type DebitFn } from "./settle.js";

export interface GatewayOptions {
  payTo?: string; // Hedera service account; empty = dev mode (x402 gate off)
  registry?: Address;
  rpcUrl?: string;
  knownModels?: string[];
  vaultAddress?: Address; // pool balance source; absent = omitted (frontend shows —)
  fallbackUpstream?: string; // e.g. http://localhost:11434
  fetchHosts?: (modelId: string) => Promise<HostInfo[]>;
  keys?: MemoryKeyStore;
  receipts?: MemoryReceiptLog;
  settle?: DebitFn; // Vault debit; absent = dev mode (no charging)
}

async function resolveHosts(opts: GatewayOptions, modelId: string): Promise<HostInfo[]> {
  if (opts.fetchHosts) return opts.fetchHosts(modelId);
  // Demo mode: static host list, no chain (HOSTS_JSON=[{endpoint,modelId,pricePerReq,...}]).
  if (process.env.HOSTS_JSON) {
    try {
      const all = JSON.parse(process.env.HOSTS_JSON) as Partial<HostInfo>[];
      return all
        .filter((h) => h.modelId === modelId)
        .map((h, i) => ({
          address: (h.address ?? `0x${String(i + 1).padStart(40, "0")}`) as `0x${string}`,
          endpoint: String(h.endpoint),
          modelId: String(h.modelId),
          modelDigest: (h.modelDigest ?? "demo") as `0x${string}`,
          pricePerReq: BigInt(h.pricePerReq ?? 1),
          pricePer1kTokens: BigInt(h.pricePer1kTokens ?? 0),
          stake: BigInt(h.stake ?? 0),
          active: true,
          lastHeartbeat: Date.now(),
          latencyMs: 200,
          reliability: 1,
        }));
    } catch {
      return [];
    }
  }
  if (!opts.registry || !opts.rpcUrl) return [];
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  return fetchEligibleHosts(client, opts.registry, modelId);
}

export function createApp(opts: GatewayOptions = {}) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "tor-gateway" }));

  const payTo = opts.payTo ?? process.env.HEDERA_SERVICE_ACCOUNT_ID ?? "";
  if (payTo) {
    app.use(
      paymentMiddleware(
        {
          "POST /v1/chat/completions": {
            accepts: [{ scheme: "exact", price: "$0.001", network: "hedera:testnet", payTo }],
            description: "TrulyOpenRouter inference — testnet USDC",
            mimeType: "application/json",
          },
        },
        createResourceServer(),
      ),
    );
  } else {
    console.warn("dev mode: x402 gate disabled (no HEDERA_SERVICE_ACCOUNT_ID)");
  }

  app.get("/v1/models", async (_req, res) => {
    const models = opts.knownModels ?? (process.env.MODELS ?? "").split(",").filter(Boolean);
    const data = [];
    for (const id of models) {
      const hosts = await resolveHosts(opts, id);
      data.push({
        id,
        owned_by: "trulyopenrouter",
        hosts: hosts.length,
        minPricePerReq: hosts.length ? String(hosts.reduce((a, b) => (a.pricePerReq < b.pricePerReq ? a : b)).pricePerReq) : null,
      });
    }
    res.json({ data });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    try {
      const model = req.body?.model;
      if (typeof model !== "string" || !model) {
        res.status(400).json({ error: { message: "missing model", type: "invalid_request" } });
        return;
      }
      // Bearer key (harness path): verify + enforce model allowlist. Absent = web/dev path.
      const auth = req.headers.authorization ?? "";
      let keyPrefix: string | undefined;
      if (auth.startsWith("Bearer ") && opts.keys) {
        const presented = auth.slice("Bearer ".length);
        const record = opts.keys.find(presented);
        if (!record || !verifyKey(presented, record)) {
          res.status(401).json({ error: { message: "invalid api key", type: "invalid_api_key" } });
          return;
        }
        keyPrefix = record.prefix;
        if (record.scopes.models && !record.scopes.models.includes(model)) {
          res.status(404).json({ error: { message: `model ${model} not in key scope`, type: "model_not_found" } });
          return;
        }
      }
      const fallback = opts.fallbackUpstream ?? process.env.UPSTREAM_URL;
      const t0 = Date.now();
      const sse = (req.headers.accept ?? "").includes("text/event-stream");
      const emit = (event: string, data: unknown) => {
        if (sse) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      if (sse) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
      }
      emit("routed", { model });
      const { endpoint, host } = await selectUpstream(model, () => resolveHosts(opts, model), fallback);
      emit("submitted", { endpoint });
      const out = await proxyChat(endpoint, req.body);
      emit("running", {});
      const usage = (out as any)?.usage ?? {};
      const tokensIn = Number(usage.prompt_tokens ?? 0);
      const tokensOut = Number(usage.completion_tokens ?? 0);
      const receiptInput = {
        promptHash: sha256hex(JSON.stringify(req.body.messages ?? req.body)),
        completionHash: sha256hex(JSON.stringify(out)),
        modelDigest: host?.modelDigest ?? "fallback",
        host: host?.address ?? "fallback",
        priceWei: String(host?.pricePerReq ?? 0),
        latencyMs: Date.now() - t0,
        tokensIn,
        tokensOut,
        modelId: model,
      };
      if (opts.receipts) opts.receipts.append(buildReceipt(receiptInput));
      const receipt = opts.receipts?.list(1)[0]?.id;
      const settled = opts.settle
        ? await settleCall(
            {
              user: keyPrefix ? `key:${keyPrefix}` : "dev",
              host,
              promptTokens: tokensIn,
              completionTokens: tokensOut,
              receiptHash: (receipt ?? "0x") as `0x${string}`,
            },
            opts.settle,
          )
        : { settled: false, amountCredits: 0n, hostShare: 0n };
      if (opts.receipts && receipt) opts.receipts.annotate(receipt, { amountCredits: String(settled.amountCredits) });
      emit("settled", { receipt });
      if (sse) {
        res.write(`data: ${JSON.stringify({ ...(out as object), tor_receipt: receipt, tor_settled: settled.settled })}\n\n`);
        res.end();
        return;
      }
      res.json({ ...(out as object), tor_receipt: receipt, tor_settled: settled.settled });
    } catch (e: any) {
      const code = String(e?.message ?? "").startsWith("no hosts") ? 404 : 502;
      res.status(code).json({ error: { message: String(e?.message ?? e), type: "upstream_error" } });
    }
  });

  app.get("/api/receipts", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    res.json({ data: opts.receipts?.list(limit) ?? [] });
  });

  app.get("/api/receipts/:id", (req, res) => {
    const r = opts.receipts?.get(req.params.id);
    if (!r) {
      res.status(404).json({ error: { message: "unknown receipt", type: "not_found" } });
      return;
    }
    res.json(r);
  });

  // Host directory for the explorer. Onchain truth + 24h call counts from receipts.
  app.get("/api/hosts", async (_req, res) => {
    const models = opts.knownModels ?? (process.env.MODELS ?? "").split(",").filter(Boolean);
    const seen = new Map<string, HostInfo>();
    for (const id of models) {
      for (const h of await resolveHosts(opts, id)) seen.set(h.address, h);
    }
    const now = Date.now();
    const all = opts.receipts?.list(10_000) ?? [];
    const day = 86_400_000;
    res.json({
      data: [...seen.values()].map((h) => ({
        address: h.address,
        endpoint: h.endpoint,
        modelId: h.modelId,
        modelDigest: h.modelDigest,
        pricePerReq: String(h.pricePerReq),
        pricePer1kTokens: String(h.pricePer1kTokens),
        stake: String(h.stake),
        active: h.active,
        lastHeartbeat: h.lastHeartbeat,
        calls24h: all.filter((r) => r.host === h.address && now - r.ts < day).length,
        latencyMs: null, // observed EMA not tracked yet
        reliability: null, // success-rate window not tracked yet
      })),
    });
  });

  // Network stats for the landing strip + explorer. Only real aggregates; anything
  // unwired is null (frontend renders "—", never a guess).
  app.get("/api/stats", async (_req, res) => {
    const models = opts.knownModels ?? (process.env.MODELS ?? "").split(",").filter(Boolean);
    const seen = new Map<string, HostInfo>();
    for (const id of models) {
      for (const h of await resolveHosts(opts, id)) seen.set(h.address, h);
    }
    const hosts = [...seen.values()];
    const now = Date.now();
    const day = 86_400_000;
    const all = opts.receipts?.list(10_000) ?? [];
    const last24h = all.filter((r) => now - r.ts < day);
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const settledToday = all.filter((r) => r.ts >= midnight.getTime()).length;
    const prices = last24h.map((r) => BigInt(r.priceWei)).filter((p) => p > 0n);
    const metered = last24h.filter(
      (r) => (r.tokensIn ?? 0) + (r.tokensOut ?? 0) > 0 && BigInt(r.amountCredits ?? "0") > 0n,
    );
    const tokensIn24h = metered.reduce((a, r) => a + (r.tokensIn ?? 0), 0);
    const tokensOut24h = metered.reduce((a, r) => a + (r.tokensOut ?? 0), 0);
    const credits24h = metered.reduce((a, r) => a + BigInt(r.amountCredits ?? "0"), 0n);
    const totalTokens = tokensIn24h + tokensOut24h;
    // $ = credits × 0.001 by defined unit (receipts.ts money rule) — frontend converts.
    const avgCreditsPer1kTokens =
      totalTokens > 0 ? String((credits24h * 1000n) / BigInt(totalTokens)) : null;
    let poolBalanceWei: string | null = null;
    if (opts.vaultAddress && opts.rpcUrl) {
      try {
        const client = createPublicClient({ transport: http(opts.rpcUrl) });
        poolBalanceWei = String(await client.getBalance({ address: opts.vaultAddress }));
      } catch {
        poolBalanceWei = null;
      }
    }
    res.json({
      hostsOnline: hosts.filter((h) => h.active).length,
      regions: null, // self-reported regions not collected yet (SPEC)
      modelsServed: models.filter((m) => hosts.some((h) => h.modelId === m)).length,
      models,
      requests24h: last24h.length,
      settledToday,
      avgPriceWeiPerReq: prices.length ? String(prices.reduce((a, b) => a + b, 0n) / BigInt(prices.length)) : null,
      tokensIn24h,
      tokensOut24h,
      avgCreditsPer1kTokens,
      poolBalanceWei,
      ts: now,
    });
  });

  // Dev key management. Production issues keys from the web app (Privy session) instead.
  app.post("/api/keys", (req, res) => {
    if (!opts.keys) {
      res.status(501).json({ error: { message: "key store not configured", type: "unavailable" } });
      return;
    }
    const scopes = (req.body?.scopes ?? {}) as KeyScopes;
    const { key, record } = issueKey(scopes);
    opts.keys.save(record);
    res.json({ key, prefix: record.prefix }); // key shown ONCE
  });

  app.delete("/api/keys/:prefix", (req, res) => {
    if (!opts.keys || !opts.keys.revoke(req.params.prefix)) {
      res.status(404).json({ error: { message: "unknown key", type: "invalid_api_key" } });
      return;
    }
    res.json({ revoked: true });
  });

  return app;
}

const PORT = Number(process.env.PORT ?? 4021);

if (import.meta.url === `file://${process.argv[1]}`) {
  // Standalone server defaults: fresh key store + receipt log (tests inject their own).
  createApp({ keys: new MemoryKeyStore(), receipts: new MemoryReceiptLog() }).listen(PORT, () =>
    console.log(`tor-gateway on :${PORT}`),
  );
}
