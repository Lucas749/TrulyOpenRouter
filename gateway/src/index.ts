import express from "express";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { paymentMiddleware } from "@x402/express";
import { createResourceServer } from "./x402.js";
import { fetchEligibleHosts, type HostInfo } from "./registry.js";
import { issueKey, MemoryKeyStore, verifyKey, type KeyScopes } from "./keys.js";
import { buildReceipt, MemoryReceiptLog, sha256hex } from "./receipts.js";
import { MemoryHealth } from "./health.js";
import { createVaultDebit } from "./vault.js";
import { MemoryHostMeta, validRegion } from "./hostmeta.js";
import { proxyChat, proxyWithFallback, selectUpstream, type X402Creds } from "./upstream.js";
import { createPaidFetch } from "./payer.js";
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
  x402?: X402Creds; // gateway payer for gated hosts (Key Ring in prod, env in dev)
  // key prefix -> vault account. Production derives a budget account per key at issuance (SPEC §4).
  payerAccounts?: Record<string, string>;
  meta?: MemoryHostMeta; // self-reported regions; absent = collection off
  health?: MemoryHealth; // upstream failure window; absent = collection off
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
    const now = Date.now();
    const all = opts.receipts?.list(10_000) ?? [];
    const day = 86_400_000;
    const data = [];
    for (const id of models) {
      const hosts = await resolveHosts(opts, id);
      const mine = all.filter((r) => r.modelId === id && now - r.ts < day);
      const tokens = mine.reduce((a, r) => a + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
      const credits = mine.reduce((a, r) => a + BigInt(r.amountCredits ?? "0"), 0n);
      data.push({
        id,
        owned_by: "trulyopenrouter",
        hosts: hosts.length,
        minPricePerReq: hosts.length ? String(hosts.reduce((a, b) => (a.pricePerReq < b.pricePerReq ? a : b)).pricePerReq) : null,
        calls24h: mine.length,
        tokens24h: tokens,
        // $ = credits × 0.001 by defined unit (receipts.ts money rule)
        avgCreditsPer1kTokens: tokens > 0 ? String((credits * 1000n) / BigInt(tokens)) : null,
      });
    }
    res.json({ data });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    let selectedHost: HostInfo | null = null;
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
      selectedHost = host;
      emit("submitted", { endpoint });
      const paidFetch = opts.x402 ? createPaidFetch({ accountId: opts.x402.accountId, privateKey: opts.x402.privateKey }) : undefined;
      const { out, paid } = await proxyWithFallback(endpoint, req.body, opts.x402, paidFetch, () => emit("paying", {}));
      if (paid) emit("paid-host", {});
      if (host && opts.health) opts.health.recordLatency(host.address, Date.now() - t0);
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
        user: keyPrefix ? `key:${keyPrefix}` : "dev",
      };
      if (opts.receipts) opts.receipts.append(buildReceipt(receiptInput));
      const receipt = opts.receipts?.list(1)[0]?.id;
      // Vault needs a real account, not the "key:<prefix>" handle: explicit per-key
      // mapping, else DEFAULT_PAYER (dev/test), else "dev" (fails closed on vault debit).
      const payer =
        (keyPrefix && opts.payerAccounts?.[keyPrefix]) || process.env.DEFAULT_PAYER || "dev";
      const settled = opts.settle
        ? await settleCall(
            {
              user: payer,
              host,
              promptTokens: tokensIn,
              completionTokens: tokensOut,
              // bytes32 link to the receipt: sha256 of the receipt id (ids are hex, not bytes).
              receiptHash: receipt ? (`0x${sha256hex(receipt)}` as `0x${string}`) : (`0x${"00".repeat(32)}` as `0x${string}`),
            },
            opts.settle,
          )
        : { settled: false, amountCredits: 0n, hostShare: 0n };
      if (opts.receipts && receipt) opts.receipts.annotate(receipt, { amountCredits: String(settled.amountCredits) });
      if (opts.settle && !settled.settled) {
        console.error(`settle failed user=${payer} host=${host?.address} amount=${settled.amountCredits}: ${settled.error}`);
      }
      emit("settled", { receipt });
      if (sse) {
        res.write(`data: ${JSON.stringify({ ...(out as object), tor_receipt: receipt, tor_settled: settled.settled })}\n\n`);
        res.end();
        return;
      }
      res.json({ ...(out as object), tor_receipt: receipt, tor_settled: settled.settled });
    } catch (e: any) {
      if (selectedHost && opts.health) opts.health.recordFail(selectedHost.address);
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
      data: [...seen.values()].map((h) => {
        const success24h = all.filter((r) => r.host === h.address && now - r.ts < day).length;
        return {
          address: h.address,
          endpoint: h.endpoint,
          modelId: h.modelId,
          modelDigest: h.modelDigest,
          pricePerReq: String(h.pricePerReq),
          pricePer1kTokens: String(h.pricePer1kTokens),
          stake: String(h.stake),
          active: h.active,
          lastHeartbeat: h.lastHeartbeat,
          calls24h: success24h,
          fail24h: opts.health?.fails24h(h.address) ?? 0,
          region: opts.meta?.regionOf(h.address) ?? null, // self-reported, never verified geo
          latencyMs: opts.health?.latencyMs(h.address) ?? null, // observed EMA, null until served
          reliability: opts.health?.reliability(success24h, h.address) ?? null,
        };
      }),
    });
  });

  // Hosts self-report their region slug. Validated, overwrite-only, no auth in dev
  // (production: signature check against the host key — see SPEC).
  app.post("/api/hosts/:address/meta", (req, res) => {
    if (!opts.meta) {
      res.status(501).json({ error: { message: "host meta not configured", type: "unavailable" } });
      return;
    }
    if (!validRegion(req.body?.region)) {
      res.status(400).json({ error: { message: "region must match [a-z0-9-]{2,32}", type: "invalid_request" } });
      return;
    }
    opts.meta.setRegion(req.params.address, req.body.region);
    res.json({ address: req.params.address, region: req.body.region });
  });

  // Per-host detail for explorer pages: onchain record + 24h activity + withdrawable earnings
  // (vault read when configured, else null — frontend shows "—").
  app.get("/api/hosts/:address", async (req, res) => {
    const models = opts.knownModels ?? (process.env.MODELS ?? "").split(",").filter(Boolean);
    let found: HostInfo | undefined;
    for (const id of models) {
      found = (await resolveHosts(opts, id)).find(
        (h) => h.address.toLowerCase() === req.params.address.toLowerCase(),
      );
      if (found) break;
    }
    if (!found) {
      res.status(404).json({ error: { message: "unknown host", type: "not_found" } });
      return;
    }
    const now = Date.now();
    const mine = (opts.receipts?.list(10_000) ?? []).filter((r) => r.host === found!.address);
    const success24h = mine.filter((r) => now - r.ts < 86_400_000).length;
    let earningsWei: string | null = null;
    if (opts.vaultAddress && opts.rpcUrl) {
      try {
        const client = createPublicClient({ transport: http(opts.rpcUrl) });
        earningsWei = String(
          await client.readContract({
            address: opts.vaultAddress,
            abi: parseAbi(["function hostEarnings(address) view returns (uint256)"]),
            functionName: "hostEarnings",
            args: [found.address as Address],
          }),
        );
      } catch {
        earningsWei = null;
      }
    }
    res.json({
      address: found.address,
      endpoint: found.endpoint,
      modelId: found.modelId,
      modelDigest: found.modelDigest,
      pricePerReq: String(found.pricePerReq),
      pricePer1kTokens: String(found.pricePer1kTokens),
      stake: String(found.stake),
      active: found.active,
      lastHeartbeat: found.lastHeartbeat,
      challenged: found.challenged ?? null,
      region: opts.meta?.regionOf(found.address) ?? null,
      calls24h: success24h,
      fail24h: opts.health?.fails24h(found.address) ?? 0,
      reliability: opts.health?.reliability(success24h, found.address) ?? null,
      latencyMs: opts.health?.latencyMs(found.address) ?? null,
      earningsWei,
      receipts: mine.slice(0, 20),
    });
  });

  // Usage slice backend: vault credit balance + this payer's receipt history.
  // :id is the payer handle ("key:<prefix>" or wallet address once web sessions map to keys).
  app.get("/api/users/:id/receipts", (req, res) => {
    const mine = (opts.receipts?.list(10_000) ?? []).filter((r) => r.user === req.params.id);
    res.json({ data: mine.slice(0, 100) });
  });

  app.get("/api/users/:id/credits", async (req, res) => {
    // Credits live onchain per wallet address; key handles have no vault account (null).
    let credits: string | null = null;
    if (opts.vaultAddress && opts.rpcUrl && /^0x[0-9a-fA-F]{40}$/.test(req.params.id)) {
      try {
        const client = createPublicClient({ transport: http(opts.rpcUrl) });
        credits = String(
          await client.readContract({
            address: opts.vaultAddress,
            abi: parseAbi(["function credits(address) view returns (uint256)"]),
            functionName: "credits",
            args: [req.params.id as Address],
          }),
        );
      } catch {
        credits = null;
      }
    }
    res.json({ id: req.params.id, credits });
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
      regions: opts.meta?.distinctRegions() ?? null,
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
  // Live legs (all env-driven, all optional in dev):
  //   REGISTRY (HostRegistry) + RPC_URL + MODELS + VAULT_ADDRESS + OPERATOR_KEY (vault debit)
  const rpcUrl = process.env.RPC_URL ?? "";
  const opts: GatewayOptions = { keys: new MemoryKeyStore(), receipts: new MemoryReceiptLog() };
  if (process.env.REGISTRY) opts.registry = process.env.REGISTRY as Address;
  if (rpcUrl) opts.rpcUrl = rpcUrl;
  if (process.env.VAULT_ADDRESS) opts.vaultAddress = process.env.VAULT_ADDRESS as Address;
  if (process.env.X402_PAYER_ID && process.env.X402_PAYER_KEY) {
    opts.x402 = { accountId: process.env.X402_PAYER_ID, privateKey: process.env.X402_PAYER_KEY };
  }
  if (process.env.VAULT_ADDRESS && rpcUrl && process.env.OPERATOR_KEY) {
    opts.settle = createVaultDebit({
      rpcUrl,
      vault: process.env.VAULT_ADDRESS as Address,
      operatorKey: process.env.OPERATOR_KEY as `0x${string}`,
    });
  }
  createApp(opts).listen(PORT, () => console.log(`tor-gateway on :${PORT}`));
}
