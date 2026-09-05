import { describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { createGuard } from "../src/index.js";

describe("guard", () => {
  it("gates chat behind 402 naming price + payee", async () => {
    const app = createGuard({ payTo: "0.0.12345" });
    const srv: Server = app.listen(0);
    const port = (srv.address() as any).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(r.status).toBe(402);
      // x402 v2 carries payment requirements in the `payment-required` header (base64 JSON).
      const header = r.headers.get("payment-required") ?? "";
      expect(header.length).toBeGreaterThan(0);
      const reqs: any = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      expect(reqs.accepts[0]).toMatchObject({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.429274", // testnet USDC
        payTo: "0.0.12345",
      });

      const health: any = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health).toMatchObject({ ok: true, payTo: "0.0.12345" });
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("proxies when gate is off (dev)", async () => {
    const stub = express();
    stub.use(express.json());
    stub.post("/v1/chat/completions", (_req, res) => res.json({ ok: "stub" }));
    const stubSrv: Server = stub.listen(0);
    const stubPort = (stubSrv.address() as any).port;
    const app = createGuard({ payTo: "", upstream: `http://127.0.0.1:${stubPort}` });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const out: any = await (
        await fetch(`http://127.0.0.1:${port}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "m" }),
        })
      ).json();
      expect(out).toEqual({ ok: "stub" });
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      await new Promise<void>((r) => stubSrv.close(() => r()));
    }
  });
});
