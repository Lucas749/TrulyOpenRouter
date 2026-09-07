import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listTaps, POST as queueTap } from "./route";
import { POST as tapAction } from "./[id]/route";

beforeEach(() => {
  process.env.GATEWAY_ADMIN_TOKEN = "sec-test-token";
  process.env.GATEWAY_URL = "http://gw.test";
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      const u = String(url);
      const auth = (init?.headers as any)?.Authorization;
      if (auth !== "Bearer sec-test-token") return { ok: false, status: 401, json: async () => ({ error: "bad" }) } as any;
      if (u.endsWith("/api/admin/taps") && (!init?.method || init.method === "GET")) {
        return { ok: true, status: 200, json: async () => ({ taps: [{ id: "tap_1", status: "pending" }] }) } as any;
      }
      if (u.endsWith("/api/admin/taps") && init?.method === "POST") {
        const body = JSON.parse(init.body);
        if (body.kind !== "heartbeat") return { ok: false, status: 400, json: async () => ({ error: "bad kind" }) } as any;
        return { ok: true, status: 200, json: async () => ({ tap: { id: "tap_9", status: "pending" }, deviceInstruction: "In Ledger Live (HBAR app): send exactly ..." }) } as any;
      }
      if (u.includes("/verify")) return { ok: true, status: 200, json: async () => ({ tap: { id: "tap_9", status: "approved" } }) } as any;
      if (u.includes("/execute")) return { ok: true, status: 200, json: async () => ({ tap: { id: "tap_9", status: "executed", execTx: "0xabc" } }) } as any;
      throw new Error(`unexpected ${u}`);
    }) as any,
  );
});

describe("security taps routes", () => {
  it("lists, queues, verifies, executes via gateway token", async () => {
    const list = await listTaps(new Request("http://x/api/security/taps"));
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).taps).toHaveLength(1);

    const queued = await queueTap(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "heartbeat" }) }));
    expect(queued.status).toBe(200);
    expect(((await queued.json()) as any).deviceInstruction).toContain("Ledger Live");

    const badKind = await queueTap(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "nuke" }) }));
    expect(badKind.status).toBe(400);

    const verified = await tapAction(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "verify" }) }), {
      params: Promise.resolve({ id: "tap_9" }),
    });
    expect(((await verified.json()) as any).tap.status).toBe("approved");

    const executed = await tapAction(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "bogus" }) }), {
      params: Promise.resolve({ id: "tap_9" }),
    });
    expect(executed.status).toBe(400);
  });

  it("501s without admin token", async () => {
    delete process.env.GATEWAY_ADMIN_TOKEN;
    expect((await listTaps(new Request("http://x"))).status).toBe(501);
    process.env.GATEWAY_ADMIN_TOKEN = "sec-test-token";
  });
});
