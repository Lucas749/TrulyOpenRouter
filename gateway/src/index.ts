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
  fallbackUpstream?: string; // e.g. http://localhost:11434
  fetchHosts?: (modelId: string) => Promise<HostInfo[]>;
  keys?: MemoryKeyStore;
  receipts?: MemoryReceiptLog;
  settle?: DebitFn; // Vault debit; absent = dev mode (no charging)
}

async function resolveHosts(opts: GatewayOptions, modelId: string): Promise<HostInfo[]> {
  if (opts.fetchHosts) return opts.fetchHosts(modelId);
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
      const receiptInput = {
        promptHash: sha256hex(JSON.stringify(req.body.messages ?? req.body)),
        completionHash: sha256hex(JSON.stringify(out)),
        modelDigest: host?.modelDigest ?? "fallback",
        host: host?.address ?? "fallback",
        priceWei: String(host?.pricePerReq ?? 0),
        latencyMs: Date.now() - t0,
      };
      if (opts.receipts) opts.receipts.append(buildReceipt(receiptInput));
      const receipt = opts.receipts?.list(1)[0]?.id;
      const settled = opts.settle
        ? await settleCall(
            {
              user: keyPrefix ? `key:${keyPrefix}` : "dev",
              host,
              promptTokens: Number(usage.prompt_tokens ?? 0),
              completionTokens: Number(usage.completion_tokens ?? 0),
              receiptHash: (receipt ?? "0x") as `0x${string}`,
            },
            opts.settle,
          )
        : { settled: false };
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
