import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/index.js";
import { PgFundingStore } from "../src/agent-funding.js";
import { PgAgents } from "../src/agents.js";
import { PgApprovals } from "../src/approvals.js";
import { budgetAddressFor } from "../src/budget.js";
import { SubscriberError } from "../src/subscriber.js";
import { normalizeSnapshot, PgTeams } from "../src/teams.js";
import type { TreasuryChain } from "../src/treasury.js";

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;

const MASTER = `0x${"ef".repeat(32)}`;
const OWNER_WALLET = privateKeyToAccount(generatePrivateKey());
const LEDGER = privateKeyToAccount(generatePrivateKey());
const HBAR = 10n ** 18n;

integration("personal agent funding routes", () => {
  const pool = new Pool({ connectionString: database, max: 8 });
  const agents = new PgAgents(pool);
  const teams = new PgTeams(pool);
  const store = new PgFundingStore(pool);
  const servers: Server[] = [];
  const chainState = { balance: 0n, credits: 0n, nonce: 0, receipts: new Map<string, "success" | "reverted">() };
  const sent: Hex[] = [];
  const chain: TreasuryChain = {
    plan: async (id) => (id === 0n ? { priceTinybar: 1_000_000_000n, credits: 10_000n } : null),
    credits: async () => chainState.credits,
    balanceWei: async () => chainState.balance,
    tokenBalance: async () => 0n,
    nonce: async () => chainState.nonce,
    gasPrice: async () => 710_000_000_000n,
    estimateGas: async () => 21_000n,
    sendRaw: async (raw) => {
      sent.push(raw);
      const tx = parseTransaction(raw);
      const hash = keccak256(raw);
      if (chainState.receipts.has(hash)) return hash;
      chainState.receipts.set(hash, "success");
      const name = tx.data && tx.data !== "0x" ? decodeFunctionData({ abi: parseAbi(["function subscribe(uint256)", "function refund()"]), data: tx.data }).functionName : "transfer";
      const fee = (tx.gas ?? 0n) * (tx.gasPrice ?? 0n);
      if (name === "subscribe") { chainState.balance -= (tx.value ?? 0n) + fee; chainState.credits += 10_000n; }
      if (name === "refund") { chainState.balance += chainState.credits * 1_000_000_000_000_000n - fee; chainState.credits = 0n; }
      if (name === "transfer") chainState.balance -= (tx.value ?? 0n) + fee;
      chainState.nonce += 1;
      return hash;
    },
    receipt: async (hash) => chainState.receipts.get(hash) ?? null,
  };
  const sessions: Record<string, { userId: string; wallets: `0x${string}`[] }> = {
    "owner-session": { userId: "did:privy:fund-owner", wallets: [OWNER_WALLET.address.toLowerCase() as `0x${string}`] },
    "other-session": { userId: "did:privy:fund-other", wallets: [] },
  };
  let base = "";
  const api = (path: string, token?: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    vi.stubEnv("BUDGET_MASTER", MASTER);
    await pool.query(`DELETE FROM agents WHERE owner_user_id LIKE 'did:privy:fund-%'`);
    await pool.query(`DELETE FROM team_finance WHERE org_id = 'fund-org'`);
    Object.assign(chainState, { balance: 0n, credits: 0n, nonce: 0 });
    chainState.receipts.clear();
    sent.length = 0;
    const server = createApp({
      verifySession: async (token) => {
        if (!sessions[token]) throw new SubscriberError(401, "authentication_required", "Invalid session");
        return sessions[token];
      },
      agents, teams, approvals: new PgApprovals(pool),
      funding: { chain, vault: "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576", budgetMaster: () => MASTER, store, paymentPending: async () => false, sleep: async () => {} },
      appOrigin: "https://tor.test",
    }).listen(0);
    servers.push(server);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });
  afterAll(async () => {
    await pool.end();
  });

  it("quotes, buys, and returns only for the agent's owner and to the owner's own wallet", async () => {
    const created = await json(await api("/api/agents", "owner-session", { name: "Budgeted", policy: { dailyCredits: 50 } }));
    const id = created.body.agent.id;
    const budget = budgetAddressFor(`agent:${id}`, MASTER)!;
    expect(created.body.agent.budgetAddress).toBe(budget);
    expect((await api(`/api/agents/${id}/funding`, "other-session")).status).toBe(404);

    const quote = await json(await api(`/api/agents/${id}/funding`, "owner-session"));
    expect(quote.body.quote).toMatchObject({ budgetAddress: budget, requiredHbar: "10.213", shortfallHbar: "10.213" });
    expect((await json(await api(`/api/agents/${id}/funding/buy`, "owner-session", { planId: 0 }))).body.error.type).toBe("insufficient_funds");

    chainState.balance = 11n * HBAR; // the owner's deposit from their wallet
    const bought = await json(await api(`/api/agents/${id}/funding/buy`, "owner-session", { planId: 0 }));
    expect(bought.body.operation).toMatchObject({ kind: "buy_credits", state: "confirmed", terms: { creditsAfter: "10000" } });

    expect((await api(`/api/agents/${id}/funding/return`, "owner-session", { destination: `0x${"12".repeat(20)}` })).status).toBe(400);
    const returned = await json(await api(`/api/agents/${id}/funding/return`, "owner-session", { destination: OWNER_WALLET.address }));
    expect(returned.body.operation.state).toBe("confirmed");
    expect(returned.body.operation.legs.map((l: any) => l.name)).toEqual(["refund", "transfer"]);
    expect(parseTransaction(returned.body.operation.legs[1].raw).to?.toLowerCase()).toBe(OWNER_WALLET.address.toLowerCase());
    expect((await json(await api(`/api/agents/${id}/funding`, "owner-session"))).body.operations).toHaveLength(2);
  });

  it("requires the enrolled Ledger to return a protected agent's funds", async () => {
    const created = await json(await api("/api/agents", "owner-session", { name: "Protected budget", policy: {} }));
    const id = created.body.agent.id;
    await agents.setLedger(id, LEDGER.address.toLowerCase(), 0);
    chainState.balance = 2n * HBAR;
    expect((await json(await api(`/api/agents/${id}/funding/return`, "owner-session", { destination: OWNER_WALLET.address }))).body.error.type).toBe("ledger_required");
    const challenge = await json(await api(`/api/agents/${id}/funding/return/challenge`, "owner-session", { destination: OWNER_WALLET.address }));
    const wrong = await api(`/api/agents/${id}/funding/return`, "owner-session", { destination: OWNER_WALLET.address, ledger: { ...challenge.body, signature: await OWNER_WALLET.signMessage({ message: challenge.body.message }) } });
    expect(wrong.status).toBe(401);
    const approved = await json(await api(`/api/agents/${id}/funding/return`, "owner-session", { destination: OWNER_WALLET.address, ledger: { ...challenge.body, signature: await LEDGER.signMessage({ message: challenge.body.message }) } }));
    expect(approved.body.operation).toMatchObject({ kind: "return_funds", state: "confirmed" });
  });

  it("points team agents to the team treasury", async () => {
    await teams.applySnapshot(normalizeSnapshot("fund-org", { defaultAllowanceCredits: null, members: [{ did: "did:privy:fund-owner", wallet: OWNER_WALLET.address, role: "owner", status: "active" }] }));
    await teams.setTeamWallet("fund-org", { name: "Fund", walletId: "w", walletAddress: `0x${"44".repeat(20)}`, quorumId: "q", policyId: "p", approverUserId: "did:privy:fund-owner", payoutRecipients: [] });
    const created = await json(await api("/api/agents", "owner-session", { name: "Team", orgId: "fund-org", policy: {} }));
    expect((await json(await api(`/api/agents/${created.body.agent.id}/funding`, "owner-session"))).body.error.type).toBe("team_agent");
  });
});
