import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { createApp } from "../src/index.js";
import { MemoryKeyStore } from "../src/keys.js";
import { MemoryReceiptLog } from "../src/receipts.js";

let base = "";
let server: Server;
const debits: unknown[][] = [];

afterAll(() => new Promise<void>((resolve) => server?.close(() => resolve())));

async function boot() {
  // stub upstream speaking OpenAI chat completions
  const stub = express();
  stub.use(express.json());
  stub.post("/chat/completions", (_req, res) =>
    res.json({ choices: [{ message: { content: "stubbed" } }] }),
  );
  const stubPort = await new Promise<number>((r) => {
    const listener = stub.listen(0, () => r((listener.address() as any).port));
  });
  const app = createApp({
    fallbackUpstream: `http://127.0.0.1:${stubPort}`,
    receipts: new MemoryReceiptLog(),
    settle: async (...args) => {
      debits.push(args);
    },
  });
  const port = await new Promise<number>((r) =>
    (server = app.listen(0, () => r((server.address() as any).port))),
  );
  base = `http://127.0.0.1:${port}`;
}

describe("routes", () => {
  it("health + models + proxied chat", async () => {
    await boot();
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true });

    const models = await (await fetch(`${base}/v1/models`)).json();
    expect(models).toEqual({ data: [] });

    const chat = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.1-8b", messages: [] }),
      })
    ).json();
    expect(chat.choices[0].message.content).toBe("stubbed");

    const bad = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(bad.status).toBe(400);
  });

  it("issues, enforces, and revokes api keys", async () => {
    const keys = new MemoryKeyStore();
    const app = createApp({ keys, fallbackUpstream: "http://127.0.0.1:1" });
    const srv = app.listen(0);
    const port = (srv.address() as any).port;
    const url = `http://127.0.0.1:${port}`;
    try {
      const issued = await (
        await fetch(`${url}/api/keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: { models: ["llama-3.1-8b"] } }),
        })
      ).json();
      expect(issued.key.startsWith("tor_sk_")).toBe(true);

      const chat = (key?: string, model = "llama-3.1-8b") =>
        fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          body: JSON.stringify({ model, messages: [] }),
        });

      expect((await chat("tor_sk_nope")).status).toBe(401);
      expect((await chat(issued.key, "qwen-2.5-7b")).status).toBe(404);

      await fetch(`${url}/api/keys/${issued.prefix}`, { method: "DELETE" });
      expect((await chat(issued.key)).status).toBe(401);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("records hashes-only receipts per call", async () => {
    const chat: any = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.1-8b", messages: [{ role: "user", content: "secret-prompt" }] }),
      })
    ).json();
    expect(chat.tor_receipt).toMatch(/^[0-9a-f]{64}$/);

    const list: any = await (await fetch(`${base}/api/receipts?limit=5`)).json();
    const mine = list.data.find((r: any) => r.id === chat.tor_receipt);
    expect(mine).toBeDefined();
    expect(JSON.stringify(mine)).not.toContain("secret-prompt");
    expect(JSON.stringify(mine)).not.toContain("stubbed");

    const one: any = await (await fetch(`${base}/api/receipts/${chat.tor_receipt}`)).json();
    expect(one.id).toBe(chat.tor_receipt);
    expect(await (await fetch(`${base}/api/receipts/nope`)).status).toBe(404);
  });

  it("settles metered debits per call", async () => {
    debits.length = 0;
    const chat: any = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.1-8b", messages: [] }),
      })
    ).json();
    expect(chat.tor_settled).toBe(true);
    expect(debits).toHaveLength(1);
    const [user, host, amount, receipt] = debits[0] as [string, string, bigint, string];
    expect(user).toBe("dev");
    expect(host).toBe("fallback");
    expect(amount).toBe(1n); // fallback flat rate
    expect(receipt).toBe(chat.tor_receipt);
  });

  it("streams status events when asked", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ model: "llama-3.1-8b", messages: [] }),
    });
    const text = await res.text();
    for (const ev of ["routed", "submitted", "running", "settled"]) {
      expect(text).toContain(`event: ${ev}`);
    }
    expect(text).toContain("tor_receipt");
  });
});
