import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createApp } from "../src/index.js";
import { FaucetError, PgHostFaucet, type FaucetSender } from "../src/faucet.js";

describe("host funding API", () => {
  it("requires the private admin hop and preserves pending and empty-pool responses", async () => {
    const claim = vi.fn().mockResolvedValue({ status: "pending", amountHbar: 5, transactionId: "0.0.12@1.2" });
    const server = createApp({ requireSubscription: false, adminToken: "private-admin", faucet: { claim } }).listen(0);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/host-faucet`;
    const post = (auth = "") => fetch(url, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ address: "host", userId: "verified-user" }) });
    try {
      expect((await post()).status).toBe(401);
      expect(claim.mock.calls.length).toBe(0);
      expect((await post("Bearer private-admin")).status).toBe(202);
      expect(claim.mock.calls[0]).toEqual(["host", "verified-user"]);
      claim.mockRejectedValue(new FaucetError(503, "faucet_empty", "Pool needs a refill."));
      const response = await post("Bearer private-admin");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { type: "faucet_empty", message: "Pool needs a refill." } });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("durable host funding grants", () => {
  const pool = new Pool({ connectionString: database });
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const user = "did:privy:host-owner";
  let sender: FaucetSender;
  beforeEach(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS host_faucet_grants (
      address text PRIMARY KEY,user_id text NOT NULL,created_at bigint NOT NULL,
      transaction_id text NOT NULL UNIQUE,signed_transaction text NOT NULL,status text NOT NULL)`);
    await pool.query("TRUNCATE host_faucet_grants");
    sender = {
      accountId: "0.0.123", address: address(123), balanceTinybar: vi.fn(async () => 10_000_000_000n),
      prepare: vi.fn(async addr => ({ transactionId: `tx-${addr}`, bytes: `signed-${addr}` })),
      settle: vi.fn(async () => "sent" as const),
    };
  });
  afterAll(async () => { await pool.end(); });
  const faucet = (owner = user, limit = 10) => new PgHostFaucet(pool, sender, async () => owner, limit);

  it("rejects unlinked hosts, invalid destinations, and unverified identities", async () => {
    await expect(faucet().claim(address(1), "did:privy:other")).rejects.toMatchObject({ status: 403 });
    await expect(faucet().claim(address(0), user)).rejects.toMatchObject({ status: 400 });
    await expect(faucet().claim(address(123), user)).rejects.toMatchObject({ status: 400 });
    await expect(faucet().claim(address(1), "forged")).rejects.toMatchObject({ status: 401 });
    expect((await pool.query("SELECT * FROM host_faucet_grants")).rows).toHaveLength(0);
  });

  it("does not consume eligibility while the pool is empty", async () => {
    vi.mocked(sender.balanceTinybar).mockResolvedValueOnce(599_999_999n);
    await expect(faucet().claim(address(1), user)).rejects.toMatchObject({ code: "faucet_empty" });
    expect((await pool.query("SELECT * FROM host_faucet_grants")).rows).toHaveLength(0);
    expect(await faucet().claim(address(1), user)).toMatchObject({ status: "sent", amountHbar: 5 });
  });

  it("persists the signed transfer before submission and reuses it after a restart", async () => {
    vi.mocked(sender.settle).mockImplementationOnce(async grant => {
      expect((await pool.query("SELECT * FROM host_faucet_grants")).rows[0].signed_transaction).toBe(grant.signed_transaction);
      throw new Error("response lost");
    });
    expect((await faucet().claim(address(1), user)).status).toBe("pending");
    expect((await faucet().claim(address(1), user)).status).toBe("sent");
    expect(vi.mocked(sender.prepare).mock.calls).toHaveLength(1);
    const submitted = vi.mocked(sender.settle).mock.calls.map(([g]) => [g.transaction_id, g.signed_transaction]);
    expect(submitted[0]).toEqual(submitted[1]);
    await faucet().claim(address(1).toUpperCase().replace("0X", "0x"), user);
    expect(vi.mocked(sender.settle).mock.calls).toHaveLength(2);
  });

  it("serializes concurrent clicks and account quotas across service instances", async () => {
    const results = await Promise.all([faucet().claim(address(1), user), faucet().claim(address(1), user)]);
    expect(results.every(r => r.status === "sent")).toBe(true);
    expect(vi.mocked(sender.prepare).mock.calls).toHaveLength(1);
    await expect(faucet().claim(address(2), user)).rejects.toMatchObject({ code: "account_limit" });
    await pool.query("UPDATE host_faucet_grants SET created_at=$1", [Date.now() - 86_400_001]);
    expect((await faucet().claim(address(2), user)).status).toBe("sent");
  });

  it("enforces a global limit even when different users race", async () => {
    const results = await Promise.allSettled([faucet(user, 1).claim(address(1), user), faucet("did:privy:other", 1).claim(address(2), "did:privy:other")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(vi.mocked(sender.prepare).mock.calls).toHaveLength(1);
  });

  it("reserves pending transfers against the available balance", async () => {
    vi.mocked(sender.balanceTinybar).mockResolvedValue(1_000_000_000n);
    vi.mocked(sender.settle).mockResolvedValue("pending");
    await faucet().claim(address(1), user);
    await expect(faucet("did:privy:other").claim(address(2), "did:privy:other")).rejects.toMatchObject({ code: "faucet_empty" });
  });
});
