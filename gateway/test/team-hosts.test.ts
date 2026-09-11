import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { hostLinkMessage, PgTeamHosts, recordCollection, TEST_USDC_FACADE, type ChainTx, type TeamHostDeps } from "../src/team-hosts.js";

const VAULT = "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576";
const HOST = `0x${"a1".repeat(20)}`;
const OTHER_HOST = `0x${"b2".repeat(20)}`;
const TEAM_WALLET = `0x${"c3".repeat(20)}`;
const OTHER_WALLET = `0x${"d4".repeat(20)}`;
const REGISTRY = `0x${"e5".repeat(20)}`;
const EVENTS = parseAbi(["event Withdrawn(address indexed host, uint256 amount)", "event Transfer(address indexed from, address indexed to, uint256 value)"]);
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const amount = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);
const withdrawnLog = (host: string, tinybar: bigint) => ({ address: VAULT, topics: encodeEventTopics({ abi: EVENTS, eventName: "Withdrawn", args: { host: host as Hex } }) as Hex[], data: amount(tinybar) });
const transferLog = (from: string, to: string, units: bigint) => ({ address: TEST_USDC_FACADE, topics: encodeEventTopics({ abi: EVENTS, eventName: "Transfer", args: { from: from as Hex, to: to as Hex } }) as Hex[], data: amount(units) });

describe("host link terms", () => {
  it("bind the team, network, registry, host, destination, nonce, and expiry", () => {
    const message = hostLinkMessage({ code: "thl_x", orgId: "org-1", teamName: "Acme", destination: TEAM_WALLET.toUpperCase().replace("0X", "0x"), expiresAt: Date.UTC(2031, 0, 1) }, HOST, REGISTRY, "https://tor.test");
    for (const part of ["origin: https://tor.test", "network: hedera-testnet (chain 296)", `registry: ${REGISTRY}`, `host: ${HOST}`, "team: Acme (org-1)", `destination: ${TEAM_WALLET}`, "nonce: thl_x", "expires: 2031-01-01T00:00:00.000Z"]) {
      expect(message).toContain(part);
    }
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;

integration("team host links and collections", () => {
  const pool = new Pool({ connectionString: database, max: 6 });
  const store = new PgTeamHosts(pool);
  const txs = new Map<string, ChainTx>();
  const d: TeamHostDeps = { store, chain: { transaction: async (h) => txs.get(h.toLowerCase()) ?? null }, vault: VAULT };
  const tx = (n: number, t: Partial<ChainTx>) => txs.set(hash(n), { from: HOST, to: VAULT, value: 0n, status: "success", logs: [], ...t });

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM team_host_links WHERE org_id LIKE 'hosts-org-%'`);
    await pool.query(`DELETE FROM host_collections WHERE org_id LIKE 'hosts-org-%'`);
    txs.clear();
  });
  afterAll(async () => {
    await pool.end();
  });

  const linkHost = async (orgId: string, destination: string, host = HOST, now = Date.now()) => {
    const link = await store.createLink({ orgId, teamName: orgId, destination, createdBy: "did:privy:owner" }, now);
    return store.activate(link.code, host, REGISTRY, "0xsig", now);
  };

  it("uses each link once before it expires and keeps one active team per host", async () => {
    const now = Date.now();
    const link = await store.createLink({ orgId: "hosts-org-1", teamName: "One", destination: TEAM_WALLET, createdBy: "did:privy:owner" }, now);
    expect(await store.activate(link.code, HOST, REGISTRY, "0xsig", now + 31 * 60_000)).toBeNull();
    const [a, b] = await Promise.all([store.activate(link.code, HOST, REGISTRY, "0xsig", now), store.activate(link.code, HOST, REGISTRY, "0xsig", now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await store.activeForHost(HOST))?.orgId).toBe("hosts-org-1");

    await linkHost("hosts-org-2", OTHER_WALLET);
    expect((await store.activeForHost(HOST))?.orgId).toBe("hosts-org-2");
    expect(await store.forOrg("hosts-org-1")).toEqual([]);
    expect(await store.revoke("hosts-org-2", HOST)).toBe(true);
    expect(await store.activeForHost(HOST)).toBeNull();
  });

  it("keeps an HBAR collection pending until a confirmed transfer reaches the team wallet", async () => {
    await expect(recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(1) })).rejects.toMatchObject({ status: 404, type: "not_linked" });
    await linkHost("hosts-org-1", TEAM_WALLET);
    await expect(recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(1) })).rejects.toMatchObject({ type: "not_confirmed" });

    tx(1, { logs: [withdrawnLog(HOST, 90_000_000n)] });
    const pending = await recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(1) });
    expect(pending).toMatchObject({ state: "pending", withdrawnTinybar: "90000000", transferTx: null });
    expect((await recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(1) })).id).toBe(pending.id);

    tx(2, { to: OTHER_WALLET, value: 9n * 10n ** 17n });
    await expect(recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(1), transferTx: hash(2) })).rejects.toMatchObject({ type: "wrong_destination" });
    tx(3, { from: OTHER_HOST, to: TEAM_WALLET, value: 9n * 10n ** 17n });
    await expect(recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(1), transferTx: hash(3) })).rejects.toMatchObject({ status: 403, type: "wrong_sender" });
    tx(4, { to: TEAM_WALLET, value: 9n * 10n ** 17n, status: "reverted" });
    await expect(recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(1), transferTx: hash(4) })).rejects.toMatchObject({ type: "reverted" });
    expect((await store.collections("hosts-org-1"))[0].state).toBe("pending");

    tx(5, { to: TEAM_WALLET, value: 9n * 10n ** 17n });
    const received = await recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(1), transferTx: hash(5) });
    expect(received).toMatchObject({ id: pending.id, state: "received", transferTx: hash(5), receivedAmount: String(9n * 10n ** 17n) });

    // Neither the withdrawal nor the transfer can back a second collection.
    tx(6, { logs: [withdrawnLog(HOST, 10_000n)] });
    await expect(recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(6), transferTx: hash(5) })).rejects.toMatchObject({ type: "already_recorded" });
    tx(7, { from: OTHER_HOST, logs: [withdrawnLog(OTHER_HOST, 10_000n)] });
    await expect(recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(7) })).rejects.toMatchObject({ type: "wrong_sender" });
    tx(8, { to: `0x${"99".repeat(20)}`, logs: [withdrawnLog(HOST, 10_000n)] });
    await expect(recordCollection(d, HOST, { asset: "hbar", withdrawTx: hash(8) })).rejects.toMatchObject({ type: "not_a_withdrawal" });
  });

  it("records test USDC only when the facade moved it from the host to the team wallet", async () => {
    await linkHost("hosts-org-1", TEAM_WALLET);
    tx(10, { to: TEST_USDC_FACADE, logs: [transferLog(HOST, OTHER_WALLET, 5_000n)] });
    await expect(recordCollection(d, HOST, { asset: "usdc", transferTx: hash(10) })).rejects.toMatchObject({ type: "wrong_destination" });
    tx(11, { to: TEST_USDC_FACADE, logs: [transferLog(HOST, TEAM_WALLET, 5_000n)] });
    expect(await recordCollection(d, HOST, { asset: "usdc", transferTx: hash(11) })).toMatchObject({ asset: "usdc", state: "received", receivedAmount: "5000" });
    await expect(recordCollection(d, HOST, { asset: "usdc", transferTx: hash(11) })).rejects.toMatchObject({ type: "already_recorded" });
  });
});
