import express from "express";
import { createPublicClient, http, type Address } from "viem";
import { paymentMiddleware } from "@x402/express";
import { createResourceServer } from "./x402.js";
import { fetchEligibleHosts, type HostInfo } from "./registry.js";
import { proxyChat, selectUpstream } from "./upstream.js";

export interface GatewayOptions {
  payTo?: string; // Hedera service account; empty = dev mode (x402 gate off)
  registry?: Address;
  rpcUrl?: string;
  knownModels?: string[];
  fallbackUpstream?: string; // e.g. http://localhost:11434
  fetchHosts?: (modelId: string) => Promise<HostInfo[]>;
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
      const fallback = opts.fallbackUpstream ?? process.env.UPSTREAM_URL;
      const { endpoint } = await selectUpstream(model, () => resolveHosts(opts, model), fallback);
      res.json(await proxyChat(endpoint, req.body));
    } catch (e: any) {
      const code = String(e?.message ?? "").startsWith("no hosts") ? 404 : 502;
      res.status(code).json({ error: { message: String(e?.message ?? e), type: "upstream_error" } });
    }
  });

  return app;
}

const PORT = Number(process.env.PORT ?? 4021);

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, () => console.log(`tor-gateway on :${PORT}`));
}
