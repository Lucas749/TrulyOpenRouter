import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/index.js";
import { SubscriberError } from "../src/subscriber.js";
import { PgTeamHosts, type ChainTx } from "../src/team-hosts.js";
import { normalizeSnapshot, PgTeams } from "../src/teams.js";

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;

const ORG = "hosts-routes-org";
const VAULT = "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576";
const TEAM_WALLET = `0x${"c7".repeat(20)}`;
const REGISTRY = `0x${"e8".repeat(20)}`;
const HOST = privateKeyToAccount(generatePrivateKey());
const STRANGER = privateKeyToAccount(generatePrivateKey());
const EVENTS = parseAbi(["event Withdrawn(address indexed host, uint256 amount)"]);
// Transaction hashes are unique across teams, so this file uses its own range.
const hash = (n: number) => `0x${"70"}${n.toString(16).padStart(62, "0")}` as Hex;

integration("team host routes", () => {
  const pool = new Pool({ connectionString: database, max: 8 });
  const teams = new PgTeams(pool);
  const txs = new Map<string, ChainTx>();
  const servers: Server[] = [];
  const sessions: Record<string, { userId: string; wallets: `0x${string}`[] }> = {
    owner: { userId: "did:privy:hr-owner", wallets: [] },
    member: { userId: "did:privy:hr-member", wallets: [] },
    outsider: { userId: "did:privy:hr-outsider", wallets: [] },
  };
  let base = "";
  const api = (path: string, token?: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });

  const linkHost = async () => {
    const created = await json(await api(`/api/team/orgs/${ORG}/hosts/links`, "owner", {}));
    const terms = await json(await api(`/api/host-links/${created.body.code}?host=${HOST.address}`));
    return { created, terms, linked: await json(await api(`/api/host-links/${created.body.code}`, undefined, { host: HOST.address, signature: await HOST.signMessage({ message: terms.body.message }) })) };
  };

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM team_host_links WHERE org_id = $1`, [ORG]);
    await pool.query(`DELETE FROM host_collections WHERE org_id = $1`, [ORG]);
    await pool.query(`DELETE FROM team_finance WHERE org_id = $1`, [ORG]);
    txs.clear();
    await teams.applySnapshot(normalizeSnapshot(ORG, {
      defaultAllowanceCredits: null,
      members: [
        { did: "did:privy:hr-owner", wallet: privateKeyToAccount(generatePrivateKey()).address, role: "owner", status: "active" },
        { did: "did:privy:hr-member", wallet: privateKeyToAccount(generatePrivateKey()).address, role: "member", status: "active" },
      ],
    }));
    await teams.setTeamWallet(ORG, { name: "Routes team", walletId: "w", walletAddress: TEAM_WALLET, quorumId: "q", policyId: "p", approverUserId: "did:privy:hr-owner", payoutRecipients: [] });
    const server = createApp({
      verifySession: async (token) => {
        if (!sessions[token]) throw new SubscriberError(401, "authentication_required", "Invalid session");
        return sessions[token];
      },
      teams,
      teamHosts: {
        store: new PgTeamHosts(pool),
        chain: { transaction: async (h) => txs.get(h) ?? null },
        vault: VAULT,
        earnings: async () => 250_000_000n,
        usdcBalance: async () => 7_000n,
      },
      hostRegistration: async (address) => (address === HOST.address.toLowerCase() ? REGISTRY : null),
      appOrigin: "https://tor.test",
    }).listen(0);
    servers.push(server);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });
  afterAll(async () => {
    await pool.end();
  });

  it("links a registered host only with its own host key over the owner's one-time terms", async () => {
    expect((await api(`/api/team/orgs/${ORG}/hosts/links`, "member", {})).status).toBe(403);
    expect((await api(`/api/team/orgs/${ORG}/hosts/links`, "outsider", {})).status).toBe(404);
    const created = await json(await api(`/api/team/orgs/${ORG}/hosts/links`, "owner", {}));
    expect(created.body).toMatchObject({ destination: TEAM_WALLET, command: `tor-host team link ${created.body.code}` });

    expect((await json(await api(`/api/host-links/${created.body.code}?host=${STRANGER.address}`))).body.error.type).toBe("not_registered");
    const terms = await json(await api(`/api/host-links/${created.body.code}?host=${HOST.address}`));
    expect(terms.body).toMatchObject({ orgId: ORG, teamName: "Routes team", destination: TEAM_WALLET, registry: REGISTRY });
    expect(terms.body.message).toContain(`host: ${HOST.address.toLowerCase()}`);

    const forged = await api(`/api/host-links/${created.body.code}`, undefined, { host: HOST.address, signature: await STRANGER.signMessage({ message: terms.body.message }) });
    expect(forged.status).toBe(401);
    const linked = await json(await api(`/api/host-links/${created.body.code}`, undefined, { host: HOST.address, signature: await HOST.signMessage({ message: terms.body.message }) }));
    expect(linked.body).toMatchObject({ orgId: ORG, destination: TEAM_WALLET, registry: REGISTRY });
    const reused = await api(`/api/host-links/${created.body.code}`, undefined, { host: HOST.address, signature: await HOST.signMessage({ message: terms.body.message }) });
    expect(reused.status).toBe(404);
    expect((await json(await api(`/api/hosts/${HOST.address}/team-link`))).body).toMatchObject({ orgId: ORG, destination: TEAM_WALLET });
  });

  it("separates earnings at hosts, collection pending, and received in the team wallet", async () => {
    await linkHost();
    txs.set(hash(1), {
      from: HOST.address.toLowerCase(), to: VAULT, value: 0n, status: "success",
      logs: [{ address: VAULT, topics: encodeEventTopics({ abi: EVENTS, eventName: "Withdrawn", args: { host: HOST.address } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [250_000_000n]) }],
    });
    txs.set(hash(2), { from: HOST.address.toLowerCase(), to: TEAM_WALLET, value: 2_490_000_000_000_000_000n, status: "success", logs: [] });

    const pending = await json(await api(`/api/hosts/${HOST.address}/collections`, undefined, { asset: "hbar", withdrawTx: hash(1) }));
    expect(pending.body.collection).toMatchObject({ state: "pending", withdrawnTinybar: "250000000" });
    let view = await json(await api(`/api/team/orgs/${ORG}/hosts`, "member"));
    expect(view.body.hosts).toEqual([expect.objectContaining({ host: HOST.address.toLowerCase(), vaultTinybar: "250000000", usdcUnits: "7000" })]);
    expect(view.body.totals).toEqual({ atHosts: { hbarTinybar: "250000000", usdcUnits: "7000" }, collectionPending: { hbarTinybar: "250000000" }, received: { hbarWei: "0", usdcUnits: "0" } });
    expect(view.body.pendingLinks).toEqual([]);

    await api(`/api/hosts/${HOST.address}/collections`, undefined, { asset: "hbar", withdrawTx: hash(1), transferTx: hash(2) });
    view = await json(await api(`/api/team/orgs/${ORG}/hosts`, "owner"));
    expect(view.body.totals.collectionPending).toEqual({ hbarTinybar: "0" });
    expect(view.body.totals.received).toEqual({ hbarWei: "2490000000000000000", usdcUnits: "0" });

    expect((await api(`/api/team/orgs/${ORG}/hosts/${HOST.address}/revoke`, "member", {})).status).toBe(403);
    expect((await api(`/api/team/orgs/${ORG}/hosts/${HOST.address}/revoke`, "owner", {})).status).toBe(200);
    expect((await api(`/api/hosts/${HOST.address}/team-link`)).status).toBe(404);
  });
});
