import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "http";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApp } from "../src/index.js";
import {
  actionHash,
  approveAmountTinybar,
  FileTapStore,
  formatHbar,
  tapInstruction,
  tapMemo,
  verifyTapTransfer,
} from "../src/taps.js";

const LEDGER = "0.0.10378181";

// Stub mirror node: one cryptotransfer tx for the ledger account.
function stubMirror(opts: { amount: number; toSelf: boolean; memo?: string; old?: boolean }) {
  const app = express();
  app.get("/api/v1/transactions", (_req, res) => {
    const transfers = opts.toSelf
      ? [
          { account: LEDGER, amount: -opts.amount },
          { account: LEDGER, amount: opts.amount },
        ]
      : [
          { account: LEDGER, amount: -opts.amount },
          { account: "0.0.999", amount: opts.amount },
        ];
    const ts = opts.old ? "1000000000.000000000" : `${Math.floor(Date.now() / 1000)}.000000000`;
    res.json({
      transactions: [
        {
          transaction_id: "0.0.10378181@1788782000.000000000",
          consensus_timestamp: ts,
          transfers,
          memo_base64: opts.memo ? Buffer.from(opts.memo).toString("base64") : "",
        },
      ],
    });
  });
  const srv: Server = app.listen(0);
  return { srv, url: `http://127.0.0.1:${(srv.address() as any).port}` };
}

afterEach(() => {
  delete process.env.MIRROR_URL;
  delete process.env.TAP_HEDERA_ACCOUNT;
});

describe("tap store", () => {
  it("queues with bound amount+memo, rejects unknown kinds, blocks double-approve", async () => {
    const store = new FileTapStore(mkdtempSync(join(tmpdir(), "tor-taps-")));
    const t = await store.queue("heartbeat", {});
    expect(t.status).toBe("pending");
    expect(t.approveAmountTinybar).toBe(approveAmountTinybar(t.id));
    expect(t.approveAmountTinybar).toBeGreaterThanOrEqual(10000);
    expect(t.approveMemo).toBe(tapMemo(t.id, t.actionHash));
    expect(tapInstruction(t, LEDGER)).toContain(formatHbar(t.approveAmountTinybar));
    expect(tapInstruction(t, LEDGER)).toContain(LEDGER);
    await expect(store.queue("nuke", {})).rejects.toThrow("unknown tap kind");
    await store.markApproved(t.id, "0.0.1@1.000000000", LEDGER);
    await expect(store.markApproved(t.id, "0.0.1@2.000000000", LEDGER)).rejects.toThrow("already approved");
    expect(actionHash("heartbeat", {})).toBe(t.actionHash);
    expect(formatHbar(15000)).toBe("0.00015");
  });
});

describe("mirror-node approval verification", () => {
  it("accepts exact self-transfer, rejects everything else", async () => {
    const store = new FileTapStore(mkdtempSync(join(tmpdir(), "tor-taps-")));
    const t = await store.queue("heartbeat", {});
    const good = stubMirror({ amount: t.approveAmountTinybar, toSelf: true });
    try {
      const txId = await verifyTapTransfer(t, LEDGER, { url: good.url, fetchFn: fetch });
      expect(txId).toContain("0.0.10378181@");
      // Wrong amount -> no match.
      const wrongAmt = stubMirror({ amount: t.approveAmountTinybar + 1, toSelf: true });
      try {
        await expect(verifyTapTransfer(t, LEDGER, { url: wrongAmt.url, fetchFn: fetch })).rejects.toThrow("no matching");
      } finally {
        wrongAmt.srv.close();
      }
      // Not to self -> no match.
      const away = stubMirror({ amount: t.approveAmountTinybar, toSelf: false });
      try {
        await expect(verifyTapTransfer(t, LEDGER, { url: away.url, fetchFn: fetch })).rejects.toThrow("no matching");
      } finally {
        away.srv.close();
      }
      // Too old -> no match.
      const old = stubMirror({ amount: t.approveAmountTinybar, toSelf: true, old: true });
      try {
        await expect(verifyTapTransfer(t, LEDGER, { url: old.url, fetchFn: fetch })).rejects.toThrow("no matching");
      } finally {
        old.srv.close();
      }
    } finally {
      good.srv.close();
    }
  });
});

describe("tap admin routes", () => {
  it("queue -> verify -> execute, with 409 before approval", async () => {
    const store = new FileTapStore(mkdtempSync(join(tmpdir(), "tor-taps-")));
    const app = createApp({ requireSubscription: false, taps: store, adminToken: "tok", tapExecutor: async () => "0xexec" });
    const srv: Server = app.listen(0);
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const auth = { Authorization: "Bearer tok", "Content-Type": "application/json" };
    try {
      expect(await (await fetch(`${base}/api/admin/taps`)).status).toBe(401);
      const queued: any = await (
        await fetch(`${base}/api/admin/taps`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "heartbeat" }) })
      ).json();
      expect(queued.tap.status).toBe("pending");
      expect(queued.deviceInstruction).toBeNull(); // TAP_HEDERA_ACCOUNT unset
      expect(await (await fetch(`${base}/api/admin/taps/${queued.tap.id}/execute`, { method: "POST", headers: auth })).status).toBe(409);
      const { srv: mirror, url } = stubMirror({ amount: queued.tap.approveAmountTinybar, toSelf: true });
      process.env.MIRROR_URL = url;
      process.env.TAP_HEDERA_ACCOUNT = LEDGER;
      try {
        const verified: any = await (
          await fetch(`${base}/api/admin/taps/${queued.tap.id}/verify`, { method: "POST", headers: auth })
        ).json();
        expect(verified.tap.status).toBe("approved");
        expect(verified.tap.tapSigner).toBe(LEDGER);
        const done: any = await (
          await fetch(`${base}/api/admin/taps/${queued.tap.id}/execute`, { method: "POST", headers: auth })
        ).json();
        expect(done.tap.status).toBe("executed");
        expect(done.tap.execTx).toBe("0xexec");
      } finally {
        mirror.close();
      }
    } finally {
      srv.close();
    }
  });
});
