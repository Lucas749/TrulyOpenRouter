import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { createApp } from "../src/index.js";

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
});
