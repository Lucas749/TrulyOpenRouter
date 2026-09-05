import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { createApp } from "../src/index.js";
import { MemoryKeyStore } from "../src/keys.js";

let base = "";
let server: Server;

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
  const app = createApp({ fallbackUpstream: `http://127.0.0.1:${stubPort}` });
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
});
