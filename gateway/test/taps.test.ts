import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApp } from "../src/index.js";
import { actionHash, tapCommand, tapMemo, TapStore, verifyTapMemo } from "../src/taps.js";

const SIGNER = "So11111111111111111111111111111111111111112";

function stubSolana(memo: string, payer: string) {
  const app = express();
  app.use(express.json());
  app.post("/", (req, res) => {
    if (req.body?.method === "getSignaturesForAddress") return res.json({ jsonrpc: "2.0", id: 1, result: [{ signature: "sig-match" }] });
    if (req.body?.method === "getTransaction") {
      return res.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          transaction: { message: { accountKeys: [payer, "other"] }, signatures: ["sig-match"] },
          meta: { logMessages: ["Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]", `Program log: Memo (len ${memo.length}): "${memo}"`, "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success"] },
        },
      });
    }
    return res.json({ jsonrpc: "2.0", id: 1, result: null });
  });
  const srv: Server = app.listen(0);
  return { srv, url: `http://127.0.0.1:${(srv.address() as any).port}` };
}

afterEach(() => {
  delete process.env.SOLANA_RPC_URL;
  delete process.env.TAP_SIGNER;
});

describe("tap store", () => {
  it("queues with bound memo, rejects unknown kinds, blocks double-approve", () => {
    const store = new TapStore(mkdtempSync(join(tmpdir(), "tor-taps-")));
    const t = store.queue("heartbeat", {});
    expect(t.status).toBe("pending");
    expect(t.approveMemo).toBe(tapMemo(t.id, t.actionHash));
    expect(tapCommand(t, SIGNER)).toContain(t.approveMemo);
    expect(() => store.queue("nuke", {})).toThrow("unknown tap kind");
    store.markApproved(t.id, "sig1", SIGNER);
    expect(() => store.markApproved(t.id, "sig2", SIGNER)).toThrow("already approved");
    expect(actionHash("heartbeat", {})).toBe(t.actionHash);
  });
});

describe("solana memo verification", () => {
  it("accepts fee-payer + exact memo, rejects impostors", async () => {
    const store = new TapStore(mkdtempSync(join(tmpdir(), "tor-taps-")));
    const t = store.queue("heartbeat", {});
    const { srv, url } = stubSolana(t.approveMemo, SIGNER);
    try {
      const sig = await verifyTapMemo(t, SIGNER, { url, fetchFn: fetch });
      expect(sig).toBe("sig-match");
      // Wrong memo onchain -> no match.
      const evil = { ...t, approveMemo: "tor-approve:evil" };
      await expect(verifyTapMemo(evil, SIGNER, { url, fetchFn: fetch })).rejects.toThrow("no matching");
      // Wrong payer -> no match.
      await expect(verifyTapMemo(t, "Attacker111111111111111111111111111111111", { url, fetchFn: fetch })).rejects.toThrow("no matching");
    } finally {
      srv.close();
    }
  });
});

describe("tap admin routes", () => {
  it("queue -> verify -> execute, with 409 before approval", async () => {
    const store = new TapStore(mkdtempSync(join(tmpdir(), "tor-taps-")));
    const app = createApp({ taps: store, adminToken: "tok", tapExecutor: async () => "0xexec" });
    const srv: Server = app.listen(0);
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const auth = { Authorization: "Bearer tok", "Content-Type": "application/json" };
    try {
      // No token -> 401.
      expect(await (await fetch(`${base}/api/admin/taps`)).status).toBe(401);
      const queued: any = await (
        await fetch(`${base}/api/admin/taps`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "heartbeat" }) })
      ).json();
      expect(queued.tap.status).toBe("pending");
      expect(queued.deviceCommand).toBeNull(); // TAP_SIGNER unset
      // Execute before approval -> 409, nothing ran.
      expect(await (await fetch(`${base}/api/admin/taps/${queued.tap.id}/execute`, { method: "POST", headers: auth })).status).toBe(409);
      // Point RPC at stub, approve, execute.
      const { srv: sol, url } = stubSolana(queued.tap.approveMemo, SIGNER);
      process.env.SOLANA_RPC_URL = url;
      process.env.TAP_SIGNER = SIGNER;
      try {
        const verified: any = await (
          await fetch(`${base}/api/admin/taps/${queued.tap.id}/verify`, { method: "POST", headers: auth })
        ).json();
        expect(verified.tap.status).toBe("approved");
        expect(verified.tap.tapTx).toBe("sig-match");
        const done: any = await (
          await fetch(`${base}/api/admin/taps/${queued.tap.id}/execute`, { method: "POST", headers: auth })
        ).json();
        expect(done.tap.status).toBe("executed");
        expect(done.tap.execTx).toBe("0xexec");
      } finally {
        sol.close();
      }
    } finally {
      srv.close();
    }
  });
});
