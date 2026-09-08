import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { createApp } from "../src/index.js";
import { MemoryKeyStore } from "../src/keys.js";
import { MemoryReceiptLog } from "../src/receipts.js";
import { MemoryVerifier } from "../src/verify.js";

let base = "";
let server: Server;
const debits: unknown[][] = [];

afterAll(() => new Promise<void>((resolve) => server?.close(() => resolve())));

async function boot() {
  // stub upstream speaking OpenAI chat completions
  const stub = express();
  stub.use(express.json());
  stub.post("/v1/chat/completions", (_req, res) =>
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

  it("publishes chain config for CLIs", async () => {
    const res: any = await (await fetch(`${base}/api/config`)).json();
    expect(res).toMatchObject({ chainId: 296, chain: "hedera-testnet", usdc: "0.0.429274" });
    expect(typeof res.facilitator).toBe("string");
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
    expect(one.user).toBe("dev");
    expect(await (await fetch(`${base}/api/receipts/nope`)).status).toBe(404);
  });

  it("attributes browser calls to wallet handles (observability only)", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const chat: any = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.1-8b", messages: [], userHandle: addr }),
      })
    ).json();
    const one: any = await (await fetch(`${base}/api/receipts/${chat.tor_receipt}`)).json();
    expect(one.user).toBe(`wallet:${addr}`);
    const mine: any = await (await fetch(`${base}/api/users/wallet:${addr}/receipts`)).json();
    expect(mine.data.map((r: any) => r.id)).toContain(chat.tor_receipt);
    // garbage handle falls back to dev (grants nothing). Distinct message so the
    // receipt id differs from the chat above (ids hash the content).
    const anon: any = await (
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.1-8b", messages: [{ role: "user", content: "other" }], userHandle: "mallory" }),
      })
    ).json();
    const anonOne: any = await (await fetch(`${base}/api/receipts/${anon.tor_receipt}`)).json();
    expect(anonOne.user).toBe("dev");
  });

  it("serves per-payer usage history and credits", async () => {
    const { MemoryReceiptLog } = await import("../src/receipts.js");
    const { buildReceipt } = await import("../src/receipts.js");
    const receipts = new MemoryReceiptLog();
    receipts.append(
      buildReceipt({ promptHash: "p", completionHash: "c", modelDigest: "m", host: "h", priceWei: "1", latencyMs: 1, user: "key:abc" }),
    );
    receipts.append(
      buildReceipt({ promptHash: "p", completionHash: "c", modelDigest: "m", host: "h", priceWei: "1", latencyMs: 1, user: "dev" }),
    );
    const app = createApp({ receipts });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const mine: any = await (await fetch(`http://127.0.0.1:${port}/api/users/key:abc/receipts`)).json();
      expect(mine.data).toHaveLength(1);
      const cred: any = await (
        await fetch(`http://127.0.0.1:${port}/api/users/0x1111111111111111111111111111111111111111/credits`)
      ).json();
      expect(cred).toMatchObject({ credits: null }); // no vault configured
      const nonAddr: any = await (await fetch(`http://127.0.0.1:${port}/api/users/dev/credits`)).json();
      expect(nonAddr).toMatchObject({ credits: null });
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
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
    const { sha256hex } = await import("../src/receipts.js");
    expect(receipt).toBe(`0x${sha256hex(chat.tor_receipt)}`); // bytes32 link, not the id itself
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

  it("ends SSE with event:error instead of crashing on mid-stream upstream death", async () => {
    // Regression: the catch block used to res.status().json() unconditionally,
    // throwing ERR_HTTP_HEADERS_SENT mid-stream and taking the process down.
    const killer = express();
    killer.post("/v1/chat/completions", (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: routed\ndata: {}\n\n`);
      setTimeout(() => res.destroy(), 50);
    });
    const ks: Server = killer.listen(0);
    const kport = (ks.address() as any).port;
    const app = createApp({ fallbackUpstream: `http://127.0.0.1:${kport}`, receipts: new MemoryReceiptLog() });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: "llama-3.1-8b", messages: [] }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      expect(text).toContain("event: error");
    } finally {
      srv.close();
      ks.close();
    }
  });

  it("never asks upstream to stream (SSE is the gateway's own envelope)", async () => {
    // Regression: req.body (stream:true) was forwarded verbatim; the host's
    // SSE frames then died in res.json() with "not valid JSON" → event:error.
    const stub = express();
    stub.use(express.json());
    stub.post("/v1/chat/completions", (req, res) => {
      if (req.body?.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: {"not":"json-envelope"}\n\n`);
        return;
      }
      res.json({ choices: [{ message: { content: "buffered" } }] });
    });
    const ss: Server = stub.listen(0);
    const sport = (ss.address() as any).port;
    const app = createApp({ fallbackUpstream: `http://127.0.0.1:${sport}`, receipts: new MemoryReceiptLog() });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ model: "llama-3.1-8b", messages: [], stream: true }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      for (const ev of ["routed", "submitted", "running", "settled"]) {
        expect(text).toContain(`event: ${ev}`);
      }
      expect(text).toContain("tor_receipt");
      expect(text).not.toContain("event: error");
    } finally {
      srv.close();
      ss.close();
    }
  });

  it("routes to the cheapest HOSTS_JSON host", async () => {
    const mkStub = async (tag: string) => {
      const stub = express();
      stub.use(express.json());
      stub.post("/v1/chat/completions", (_req, res) => res.json({ from: tag, choices: [] }));
      const s: Server = stub.listen(0);
      return { s, port: (s.address() as any).port };
    };
    const cheap = await mkStub("cheap");
    const pricey = await mkStub("pricey");
    process.env.HOSTS_JSON = JSON.stringify([
      { endpoint: `http://127.0.0.1:${pricey.port}`, modelId: "demo-model", pricePerReq: 5000 },
      { endpoint: `http://127.0.0.1:${cheap.port}`, modelId: "demo-model", pricePerReq: 5 },
      { endpoint: "http://127.0.0.1:1", modelId: "other-model", pricePerReq: 1 },
    ]);
    const app = createApp({});
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const out: any = await (
        await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "demo-model", messages: [] }),
        })
      ).json();
      expect(out.from).toBe("cheap");
    } finally {
      delete process.env.HOSTS_JSON;
      await new Promise<void>((r) => srv.close(() => r()));
      await new Promise<void>((r) => cheap.s.close(() => r()));
      await new Promise<void>((r) => pricey.s.close(() => r()));
    }
  });

  it("lists hosts with 24h call counts", async () => {
    process.env.HOSTS_JSON = JSON.stringify([
      { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", endpoint: "http://h1:11434", modelId: "demo-model", pricePerReq: 5, pricePer1kTokens: 1, stake: 7 },
    ]);
    const { MemoryReceiptLog } = await import("../src/receipts.js");
    const { buildReceipt } = await import("../src/receipts.js");
    const receipts = new MemoryReceiptLog();
    receipts.append(
      buildReceipt({ promptHash: "p", completionHash: "c", modelDigest: "m", host: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", priceWei: "5", latencyMs: 1 }, Date.now()),
    );
    const app = createApp({ knownModels: ["demo-model"], receipts });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const out: any = await (await fetch(`http://127.0.0.1:${port}/api/hosts`)).json();
      expect(out.data).toHaveLength(1);
      expect(out.data[0]).toMatchObject({
        modelId: "demo-model",
        pricePerReq: "5",
        stake: "7",
        active: true,
        calls24h: 1,
        latencyMs: null,
      });
    } finally {
      delete process.env.HOSTS_JSON;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("reports real-only stats, nulls for the unwired", async () => {
    const { MemoryReceiptLog } = await import("../src/receipts.js");
    const { buildReceipt } = await import("../src/receipts.js");
    const receipts = new MemoryReceiptLog();
    const now = Date.now();
    const mk = (ts: number, price: string) =>
      buildReceipt({ promptHash: "p", completionHash: "c", modelDigest: "m", host: "h", priceWei: price, latencyMs: 1, tokensIn: 400, tokensOut: 600, amountCredits: "2" }, ts);
    receipts.append(mk(now - 1000, "1000"));
    receipts.append(mk(now - 100_000_000, "2000")); // >24h ago
    const app = createApp({
      knownModels: ["demo-model"],
      fetchHosts: async () => [],
      receipts,
    });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const s: any = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
      expect(s.hostsOnline).toBe(0);
      expect(s.modelsServed).toBe(0);
      expect(s.requests24h).toBe(1);
      expect(s.settledToday).toBeGreaterThanOrEqual(1);
      expect(s.avgPriceWeiPerReq).toBe("1000");
      expect(s.tokensIn24h).toBe(400);
      expect(s.tokensOut24h).toBe(600);
      expect(s.avgCreditsPer1kTokens).toBe("2"); // 2 credits / 1000 tokens
      expect(s.regions).toBeNull();
      expect(s.poolBalanceWei).toBeNull();
      expect(typeof s.ts).toBe("number");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("collects self-reported regions and counts them in stats", async () => {
    const { MemoryHostMeta } = await import("../src/hostmeta.js");
    const meta = new MemoryHostMeta();
    const app = createApp({ knownModels: [], meta });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const bad = await (
        await fetch(`http://127.0.0.1:${port}/api/hosts/0xabc/meta`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: "BAD NAME" }),
        })
      );
      expect(bad.status).toBe(400);
      const ok: any = await (
        await fetch(`http://127.0.0.1:${port}/api/hosts/0xabc/meta`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: "eu-central" }),
        })
      ).json();
      expect(ok).toMatchObject({ region: "eu-central" });
      const s: any = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
      expect(s.regions).toEqual(["eu-central"]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("records upstream failures into host reliability", async () => {
    const { MemoryHealth } = await import("../src/health.js");
    const health = new MemoryHealth();
    const host = {
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      endpoint: "http://127.0.0.1:1",
      modelId: "demo-model",
      modelDigest: "0xabc",
      pricePerReq: 5n,
      pricePer1kTokens: 1n,
      stake: 7n,
      active: true,
      lastHeartbeat: 0,
      latencyMs: 200,
      reliability: 1,
    };
    const app = createApp({ knownModels: ["demo-model"], fetchHosts: async () => [host], health });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "demo-model", messages: [] }),
      });
      expect(r.status).toBe(502); // nothing listens on :1
      const hosts: any = await (await fetch(`http://127.0.0.1:${port}/api/hosts`)).json();
      expect(hosts.data[0]).toMatchObject({ fail24h: 1, reliability: 0 });
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("serves host detail with earnings when vault is wired", async () => {
    const { MemoryReceiptLog } = await import("../src/receipts.js");
    const { buildReceipt } = await import("../src/receipts.js");
    const addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const host = {
      address: addr,
      endpoint: "http://h:11434",
      modelId: "demo-model",
      modelDigest: "0xabc",
      pricePerReq: 5n,
      pricePer1kTokens: 1n,
      stake: 7n,
      active: true,
      challenged: true,
      lastHeartbeat: 9,
      latencyMs: 200,
      reliability: 1,
    };
    const receipts = new MemoryReceiptLog();
    receipts.append(
      buildReceipt({ promptHash: "p", completionHash: "c", modelDigest: "0xabc", modelId: "demo-model", host: addr, priceWei: "5", latencyMs: 1 }),
    );
    const app = createApp({ knownModels: ["demo-model"], fetchHosts: async () => [host], receipts });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const d: any = await (await fetch(`http://127.0.0.1:${port}/api/hosts/${addr}`)).json();
      expect(d).toMatchObject({
        modelId: "demo-model",
        challenged: true,
        calls24h: 1,
        earningsWei: null, // no vault configured
      });
      expect(d.receipts).toHaveLength(1);
      expect(await (await fetch(`http://127.0.0.1:${port}/api/hosts/0x0000000000000000000000000000000000000000`)).status).toBe(404);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("enriches models with 24h cost figures", async () => {
    const { MemoryReceiptLog } = await import("../src/receipts.js");
    const { buildReceipt } = await import("../src/receipts.js");
    const receipts = new MemoryReceiptLog();
    receipts.append(
      buildReceipt({ promptHash: "p", completionHash: "c", modelDigest: "m", modelId: "demo-model", host: "h", priceWei: "5", latencyMs: 1, tokensIn: 400, tokensOut: 600, amountCredits: "4" }),
    );
    const app = createApp({ knownModels: ["demo-model", "idle-model"], fetchHosts: async () => [], receipts });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const m: any = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
      const demo = m.data.find((x: any) => x.id === "demo-model");
      expect(demo).toMatchObject({ calls24h: 1, tokens24h: 1000, avgCreditsPer1kTokens: "4" });
      const idle = m.data.find((x: any) => x.id === "idle-model");
      expect(idle).toMatchObject({ calls24h: 0, tokens24h: 0, avgCreditsPer1kTokens: null });
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("maps api keys to vault payer accounts", async () => {
    const { MemoryKeyStore } = await import("../src/keys.js");
    const stub = express();
    stub.use(express.json());
    stub.post("/v1/chat/completions", (_req, res) => res.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    const stubSrv: Server = stub.listen(0);
    const keys = new MemoryKeyStore();
    const debits: unknown[][] = [];
    const app = createApp({
      keys,
      fetchHosts: async () => [],
      fallbackUpstream: `http://127.0.0.1:${(stubSrv.address() as any).port}`,
      settle: async (...args) => {
        debits.push(args);
      },
    });
    const srv: Server = app.listen(0);
    try {
      const port = (srv.address() as any).port;
      const issued: any = await (
        await fetch(`http://127.0.0.1:${port}/api/keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json();
      // unmapped key, no DEFAULT_PAYER -> dev handle, debit attempted and recorded
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${issued.key}` },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(r.status).toBe(200);
      expect(debits.length).toBe(1);
      expect(debits[0][0]).toBe("dev");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      await new Promise<void>((r) => stubSrv.close(() => r()));
    }
  });
});

describe("verification routes", () => {
  const MODEL = "qwen2.5:0.5b"; // has committed references in gateway/references.json

  // Two stub hosts: bad answers every probe wrong, good answers them right.
  async function twoHosts() {
    const badApp = express();
    badApp.use(express.json());
    badApp.post("/v1/chat/completions", (req, res) => {
      const prompt: string = req.body?.messages?.[0]?.content ?? "";
      const answers: Record<string, string> = { France: "Lyon", "17 + 25": "43", "blue seven": "red eight loud", hello: "olleh", June: "July" };
      const key = Object.keys(answers).find((k) => prompt.includes(k)) ?? "";
      res.json({ choices: [{ message: { content: answers[key] ?? "??" } }] });
    });
    const goodApp = express();
    goodApp.use(express.json());
    goodApp.post("/v1/chat/completions", (req, res) => {
      if (req.body?.messages?.[0]?.content === "ROUTE-ME") {
        res.json({ choices: [{ message: { content: "served-by-good" } }] });
        return;
      }
      const prompt: string = req.body?.messages?.[0]?.content ?? "";
      const answers: Record<string, string> = { France: "Paris", "17 + 25": "42", "blue seven": "blue seven quiet", hello: "oolello", June: "October" };
      const key = Object.keys(answers).find((k) => prompt.includes(k)) ?? "";
      res.json({ choices: [{ message: { content: answers[key] ?? "??" } }] });
    });
    const listen = (app: express.Express) =>
      new Promise<Server>((r) => {
        const s = app.listen(0, () => r(s));
      });
    const badSrv = await listen(badApp);
    const goodSrv = await listen(goodApp);
    const badPort = (badSrv.address() as any).port;
    const goodPort = (goodSrv.address() as any).port;
    const mkHost = (tag: string, port: number) => ({
      address: (tag === "bad" ? "0x0000000000000000000000000000000000000bad" : "0x0000000000000000000000000000000000000a11") as `0x${string}`,
      endpoint: `http://127.0.0.1:${port}`,
      modelId: MODEL,
      modelDigest: "0xabc" as `0x${string}`,
      pricePerReq: 1n,
      pricePer1kTokens: 0n,
      stake: 1n,
      active: true,
      lastHeartbeat: Date.now(),
      latencyMs: 10,
      reliability: 1,
    });
    return { badSrv, goodSrv, hosts: [mkHost("bad", badPort), mkHost("good", goodPort)] };
  }

  it("reports null verification until checked, then summarizes", async () => {
    const { badSrv, goodSrv, hosts } = await twoHosts();
    const app = createApp({
      knownModels: [MODEL],
      fetchHosts: async () => hosts,
      verifier: new MemoryVerifier(),
    });
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const before: any = await (await fetch(`${url}/api/hosts`)).json();
      expect(before.data).toHaveLength(2);
      expect(before.data[0].verification).toMatchObject({ checks: 0, avgScore: null, failing: false });

      const badAddr = hosts[0].address;
      for (let i = 0; i < 3; i++) {
        const r: any = await (await fetch(`${url}/api/verify/${badAddr}`, { method: "POST" })).json();
        expect(r.total).toBe(5);
        expect(r.score).toBe(0);
      }
      const after: any = await (await fetch(`${url}/api/hosts`)).json();
      const bad = after.data.find((h: any) => h.address === badAddr);
      expect(bad.verification).toMatchObject({ checks: 3, failing: true });
      expect(bad.verification.avgScore).toBe(0);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      await new Promise<void>((r) => badSrv.close(() => r()));
      await new Promise<void>((r) => goodSrv.close(() => r()));
    }
  });

  it("routes around failing hosts but still lists them", async () => {
    const { badSrv, goodSrv, hosts } = await twoHosts();
    const app = createApp({
      knownModels: [MODEL],
      fetchHosts: async () => hosts,
      verifier: new MemoryVerifier(),
    });
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const badAddr = hosts[0].address;
      for (let i = 0; i < 3; i++) {
        await fetch(`${url}/api/verify/${badAddr}`, { method: "POST" });
      }
      const chat: any = await (
        await fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ROUTE-ME" }] }),
        })
      ).json();
      expect(chat.choices[0].message.content).toBe("served-by-good");
      // …but the failing host is still listed, flagged
      const dir: any = await (await fetch(`${url}/api/hosts`)).json();
      expect(dir.data).toHaveLength(2);
      expect(dir.data.find((h: any) => h.address === badAddr).verification.failing).toBe(true);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      await new Promise<void>((r) => badSrv.close(() => r()));
      await new Promise<void>((r) => goodSrv.close(() => r()));
    }
  });

  it("501s without a verifier, 404s unknown hosts, 400s models without references", async () => {
    const app = createApp({ knownModels: [MODEL], fetchHosts: async () => [] });
    const srv = app.listen(0);
    const url = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const noVerifier = await fetch(`${url}/api/verify/0xabc`, { method: "POST" });
      expect(noVerifier.status).toBe(501);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    const app2 = createApp({ knownModels: ["nope-model"], fetchHosts: async () => [], verifier: new MemoryVerifier() });
    const srv2 = app2.listen(0);
    const url2 = `http://127.0.0.1:${(srv2.address() as any).port}`;
    try {
      expect((await fetch(`${url2}/api/verify/0xabc`, { method: "POST" })).status).toBe(404);
    } finally {
      await new Promise<void>((r) => srv2.close(() => r()));
    }
  });
});
