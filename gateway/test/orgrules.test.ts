import { describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { createApp } from "../src/index.js";
import { MemoryOrgRules } from "../src/orgrules.js";
import { MemoryReceiptLog, buildReceipt } from "../src/receipts.js";

function spentReceipt(user: string, amount: string, ts: number) {
  return { ...buildReceipt({ promptHash: "p", completionHash: "c", modelDigest: "m", host: "h", priceWei: "1", latencyMs: 1 }, ts), user, amountCredits: amount };
}

describe("org rules", () => {
  it("stores, reads, and matches handles", async () => {
    const s = new MemoryOrgRules();
    expect(await s.get("o1")).toBeNull();
    await s.set({ orgId: "o1", dailyCapCredits: 100, allowedModels: ["m1"], handles: ["key:abc", "wallet:0x1"] });
    expect(await s.get("o1")).toMatchObject({ dailyCapCredits: 100 });
    expect(await s.orgsForHandle("key:abc")).toHaveLength(1);
    expect(await s.orgsForHandle("wallet:nobody")).toHaveLength(0);
    // handles normalize case at write: checksummed wallets still match
    await s.set({ orgId: "o2", dailyCapCredits: null, allowedModels: null, handles: ["wallet:0xABCDEF"] });
    expect(await s.orgsForHandle("wallet:0xabcdef")).toHaveLength(1);
    await expect(s.set({ orgId: "", dailyCapCredits: null, allowedModels: null, handles: [] })).rejects.toThrow("orgId required");
  });

  it("blocks disallowed models (403 plain language) and breached daily ceilings (429)", async () => {
    const stub = express();
    stub.use(express.json());
    stub.post("/v1/chat/completions", (_req, res) => res.json({ choices: [{ message: { content: "ok" } }] }));
    const stubSrv: Server = stub.listen(0);
    const stubPort = (stubSrv.address() as any).port;
    const receipts = new MemoryReceiptLog();
    const orgRules = new MemoryOrgRules();
    await orgRules.set({ orgId: "o1", dailyCapCredits: 15, allowedModels: ["llama-3.1-8b"], handles: ["wallet:0x0000000000000000000000000000000000000abc"] });
    const app = createApp({ requireSubscription: false, receipts, orgRules, fallbackUpstream: `http://127.0.0.1:${stubPort}` });
    const srv: Server = app.listen(0);
    const port = (srv.address() as any).port;
    const chat = (model: string, handle?: string, text = "hi") =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: text }], ...(handle ? { userHandle: handle } : {}) }),
      });
    try {
      // wrong model -> 403 in plain words even with budget left
      const bad = await chat("qwen2.5:0.5b", "0x0000000000000000000000000000000000000abc");
      expect(bad.status).toBe(403);
      const badBody: any = await bad.json();
      expect(badBody.error.type).toBe("org_policy");
      expect(badBody.error.message).toContain("Not allowed in your organization");
      // right model, under ceiling -> 200
      expect((await chat("llama-3.1-8b", "0x0000000000000000000000000000000000000abc", "one")).status).toBe(200);
      // spend 20 (over the 15 ceiling) then next call 429s
      await receipts.append(spentReceipt("wallet:0x0000000000000000000000000000000000000abc", "20", Date.now()));
      const over = await chat("llama-3.1-8b", "0x0000000000000000000000000000000000000abc", "two");
      expect(over.status).toBe(429);
      expect(((await over.json()) as any).error.type).toBe("quota_exceeded");
      // strangers (no org) serve normally
      expect((await chat("llama-3.1-8b", undefined, "stranger")).status).toBe(200);
    } finally {
      srv.close();
      stubSrv.close();
    }
  });

  it("routes within allowed regions, 403s outside in plain language", async () => {
    const stub = express();
    stub.use(express.json());
    stub.post("/v1/chat/completions", (_req, res) => res.json({ choices: [{ message: { content: "ok" } }] }));
    const stubSrv: Server = stub.listen(0);
    const stubPort = (stubSrv.address() as any).port;
    const { MemoryHostMeta } = await import("../src/hostmeta.js");
    const meta = new MemoryHostMeta();
    await meta.setGeo("0xhost1", "us-oregon");
    const orgRules = new MemoryOrgRules();
    const member = "0x0000000000000000000000000000000000000bbb";
    await orgRules.set({ orgId: "o2", dailyCapCredits: null, allowedModels: null, allowedRegions: ["us-oregon"], requireVerified: false, handles: [`wallet:${member}`] });
    process.env.HOSTS_JSON = JSON.stringify([{ address: "0xhost1", endpoint: `http://127.0.0.1:${stubPort}`, modelId: "m", pricePerReq: 1 }]);
    const app = createApp({ requireSubscription: false, meta, orgRules });
    const srv: Server = app.listen(0);
    const port = (srv.address() as any).port;
    const chat = () =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }], userHandle: member }),
      });
    try {
      // host geo us-oregon ∈ allowed → served
      expect((await chat()).status).toBe(200);
      // tighten to eu-west → same host now excluded → plain 403
      await orgRules.set({ orgId: "o2", dailyCapCredits: null, allowedModels: null, allowedRegions: ["eu-west"], requireVerified: false, handles: [`wallet:${member}`] });
      const denied = await chat();
      expect(denied.status).toBe(403);
      expect(((await denied.json()) as any).error.message).toContain("Not allowed in your organization");
    } finally {
      delete process.env.HOSTS_JSON;
      srv.close();
      stubSrv.close();
    }
  });

  it("rate-limits orgs and pins hosts", async () => {
    const stub = express();
    stub.use(express.json());
    stub.post("/v1/chat/completions", (_req, res) => res.json({ choices: [{ message: { content: "ok" } }] }));
    const stubSrv: Server = stub.listen(0);
    const stubPort = (stubSrv.address() as any).port;
    const receipts = new MemoryReceiptLog();
    const orgRules = new MemoryOrgRules();
    const member = "0x0000000000000000000000000000000000000ccc";
    const host = "0x0000000000000000000000000000000000000ddd";
    await orgRules.set({ orgId: "o3", dailyCapCredits: null, allowedModels: null, allowedRegions: null, requireVerified: false, rateLimitPerMin: 1, pinnedHosts: [host], handles: [`wallet:${member}`] });
    process.env.HOSTS_JSON = JSON.stringify([
      { address: host, endpoint: `http://127.0.0.1:${stubPort}`, modelId: "m", pricePerReq: 1 },
      { address: "0x0000000000000000000000000000000000000eee", endpoint: `http://127.0.0.1:${stubPort}`, modelId: "m", pricePerReq: 1 },
    ]);
    const app = createApp({ requireSubscription: false, receipts, orgRules });
    const srv: Server = app.listen(0);
    const port = (srv.address() as any).port;
    const chat = (text: string) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: text }], userHandle: member }),
      });
    try {
      expect((await chat("first")).status).toBe(200);
      // second call inside the minute -> 429
      const limited = await chat("second");
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as any).error.type).toBe("quota_exceeded");
      // pin to a host that doesn't exist -> routing pool empties -> plain 403
      await orgRules.set({ orgId: "o3", dailyCapCredits: null, allowedModels: null, allowedRegions: null, requireVerified: false, rateLimitPerMin: null, pinnedHosts: ["0x0000000000000000000000000000000000000fff"], handles: [`wallet:${member}`] });
      const pinned = await chat("third");
      expect(pinned.status).toBe(403);
      expect(((await pinned.json()) as any).error.message).toContain("Not allowed in your organization");
    } finally {
      delete process.env.HOSTS_JSON;
      srv.close();
      stubSrv.close();
    }
  });

  it("admin org-rules endpoint validates", async () => {
    const app = createApp({ requireSubscription: false, orgRules: new MemoryOrgRules(), adminToken: "t" });
    const srv: Server = app.listen(0);
    const port = (srv.address() as any).port;
    const auth = { Authorization: "Bearer t", "Content-Type": "application/json" };
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/api/admin/org-rules`, { method: "POST", headers: auth, body: JSON.stringify({}) })).status).toBe(400);
      const badCap = await fetch(`http://127.0.0.1:${port}/api/admin/org-rules`, {
        method: "POST", headers: auth, body: JSON.stringify({ orgId: "o", dailyCapCredits: -1, handles: [] }),
      });
      expect(badCap.status).toBe(400);
      const ok = await fetch(`http://127.0.0.1:${port}/api/admin/org-rules`, {
        method: "POST", headers: auth, body: JSON.stringify({ orgId: "o9", dailyCapCredits: 50, allowedModels: ["m"], handles: ["wallet:0x9"] }),
      });
      expect(ok.status).toBe(200);
      const got: any = await (await fetch(`http://127.0.0.1:${port}/api/admin/org-rules/o9`, { headers: { Authorization: "Bearer t" } })).json();
      expect(got.rule).toMatchObject({ orgId: "o9", dailyCapCredits: 50 });
    } finally {
      srv.close();
    }
  });
});
