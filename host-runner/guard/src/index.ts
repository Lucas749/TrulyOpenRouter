import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

export interface GuardOptions {
  payTo?: string; // host wallet; falls back to HOST_WALLET, empty = dev mode
  upstream?: string; // Ollama/OpenAI baseURL, default http://127.0.0.1:11434
  facilitatorUrl?: string; // default Blocky402 testnet
  priceUsdc?: string; // default $0.001
}

export function createGuard(opts: GuardOptions) {
  const payTo = opts.payTo || process.env.HOST_WALLET || "";
  const upstream = (opts.upstream ?? process.env.UPSTREAM_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const base = upstream.endsWith("/v1") ? upstream : `${upstream}/v1`;
  const facilitatorUrl =
    opts.facilitatorUrl ?? process.env.X402_TESTNET_FACILITATOR_URL ?? "https://api.testnet.blocky402.com";

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "tor-guard", payTo }));

  if (payTo) {
    const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl })).register(
      "hedera:*",
      new ExactHederaScheme({}),
    );
    const route = {
      accepts: [
        { scheme: "exact" as const, price: opts.priceUsdc ?? "$0.001", network: "hedera:testnet" as const, payTo },
      ],
      description: "Host inference — testnet USDC",
      mimeType: "application/json",
    };
    app.use(
      paymentMiddleware(
        {
          "POST /chat/completions": route,
          "POST /v1/chat/completions": route,
        },
        rs,
      ),
    );
  } else {
    console.warn("dev mode: x402 gate disabled (no HOST_WALLET)");
  }

  // OpenAI-compatible paths: bare base serves /chat/*, versioned base serves /v1/chat/*.
  const handleChat = async (req: any, res: any) => {
    try {
      const upstreamRes = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      res.status(upstreamRes.status);
      const ct = upstreamRes.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      // SSE streams pipe through byte-for-byte; only buffered JSON gets parsed.
      if (ct?.includes("text/event-stream") && upstreamRes.body) {
        for await (const chunk of upstreamRes.body as any) res.write(chunk);
        res.end();
        return;
      }
      res.json(await upstreamRes.json());
    } catch (e) {
      res.status(502).json({ error: { message: `upstream error: ${String(e)}`, type: "upstream_error" } });
    }
  };
  app.post("/chat/completions", handleChat);
  app.post("/v1/chat/completions", handleChat);

  return app;
}

const PORT = Number(process.env.GUARD_PORT ?? 4122);

if (import.meta.url === `file://${process.argv[1]}`) {
  createGuard({}).listen(PORT, () => console.log(`tor-guard on :${PORT}`));
}
