import express from "express";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { createApp, resolveHosts } from "../src/index.js";

// An operator's HOSTS_JSON host has no registered address, so it names the account
// its guard is paid at. The gateway pays that account and still refuses any other.

const HOST_ACCOUNT = "0.0.6006";
const HOST_EVM = `0x${"ab".repeat(20)}`;
const KEY = PrivateKey.generateECDSA().toStringRaw();
const requirement = { scheme: "exact", network: "hedera:testnet", asset: "0.0.429274", amount: "1000", payTo: HOST_ACCOUNT, maxTimeoutSeconds: 180, extra: { feePayer: "0.0.7007" } };

afterEach(() => vi.unstubAllEnvs());

async function gatedHost() {
  const payments: string[] = [];
  const app = express();
  app.post("/v1/chat/completions", (req, res) => {
    const signature = req.header("PAYMENT-SIGNATURE");
    if (signature) {
      payments.push(signature);
      res.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
      return;
    }
    const resource = { url: `http://${req.get("host")}${req.originalUrl}`, description: "chat", mimeType: "application/json" };
    res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader({ x402Version: 2, error: "Payment required", resource, accepts: [requirement] } as any)).json({});
  });
  const server: Server = app.listen(0);
  return { server, port: (server.address() as { port: number }).port, payments };
}

it.each([
  ["pays an operator host at its declared payee", { payee: HOST_EVM }, 200, 1],
  ["refuses an operator host that declares no payee", {}, 503, 0],
])("%s", async (_label, declared, status, payments) => {
  const host = await gatedHost();
  vi.stubEnv("HOSTS_JSON", JSON.stringify([{ endpoint: `http://127.0.0.1:${host.port}`, modelId: "demo-model", pricePerReq: 1, ...declared }]));
  const gateway = createApp({
    requireSubscription: false,
    x402: { accountId: "0.0.5005", privateKey: KEY },
    hederaAccounts: { evmAddress: async (id) => (id === HOST_ACCOUNT ? HOST_EVM : null), tokenBalance: async () => 1_000_000n },
  }).listen(0);
  try {
    const port = (gateway.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "demo-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(status);
    if (status === 503) expect((await res.json()).error.type).toBe("host_payment_refused");
    expect(host.payments).toHaveLength(payments);
  } finally {
    await new Promise<void>((r) => gateway.close(() => r()));
    await new Promise<void>((r) => host.server.close(() => r()));
  }
});

it("rejects a host list whose payee is not an address", async () => {
  vi.stubEnv("HOSTS_JSON", JSON.stringify([{ endpoint: "http://guard:4122", modelId: "demo-model", payee: "0.0.6006" }]));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await resolveHosts({}, "demo-model")).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("HOSTS_JSON is invalid"));
  warn.mockRestore();
});
