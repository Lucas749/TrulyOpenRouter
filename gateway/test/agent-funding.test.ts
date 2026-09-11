import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { buyAgentCredits, FundingError, fundingQuote, PgFundingStore, returnAgentFunds, type FundingOp, type FundingStore } from "../src/agent-funding.js";
import { normalizePolicy, type Agent } from "../src/agents.js";
import { budgetAddressFor } from "../src/budget.js";
import type { TreasuryChain } from "../src/treasury.js";

const MASTER = `0x${"ab".repeat(32)}`;
const VAULT = "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576";
const OWNER_WALLET = `0x${"9e".repeat(20)}`;
const HBAR = 10n ** 18n;
const GAS_PRICE = 710_000_000_000n;

class MemoryFundingStore implements FundingStore {
  rows = new Map<string, FundingOp>();
  async open(agentId: string) {
    return structuredClone([...this.rows.values()].find((o) => o.agentId === agentId && ["signed", "submitted", "uncertain"].includes(o.state)) ?? null);
  }
  async insert(op: FundingOp) {
    if (await this.open(op.agentId)) throw new FundingError(409, "funding_busy", "busy");
    this.rows.set(op.id, structuredClone(op));
  }
  async update(id: string, patch: Partial<FundingOp>) {
    const row = this.rows.get(id)!;
    Object.assign(row, patch, { updatedAt: Date.now() });
    return structuredClone(row);
  }
  async recent(agentId: string) {
    return [...this.rows.values()].filter((o) => o.agentId === agentId).map((o) => structuredClone(o));
  }
}

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: "agt_fund", name: "Personal", description: "", ownerUserId: "did:privy:owner", orgId: null, sponsorDid: null, payerKind: "personal",
    budgetLabel: "agent:agt_fund", state: "ready", policy: normalizePolicy({}), policyRevision: 1, ledgerAddress: null, ledgerRevision: 0,
    createdAt: 1, updatedAt: 1, ...over,
  };
}

function fakeChain(budget: string) {
  const state = { balance: 0n, credits: 0n, nonce: 4, receipts: new Map<string, "success" | "reverted">(), autoReceipt: true, revertNames: new Set<string>() };
  const sent: Hex[] = [];
  const chain: TreasuryChain = {
    plan: async (id) => (id === 0n ? { priceTinybar: 1_000_000_000n, credits: 10_000n } : null),
    credits: async () => state.credits,
    balanceWei: async () => state.balance,
    tokenBalance: async () => 0n,
    nonce: async () => state.nonce,
    gasPrice: async () => GAS_PRICE,
    estimateGas: async () => 100_000n,
    sendRaw: async (raw) => {
      sent.push(raw);
      const tx = parseTransaction(raw);
      const hash = keccak256(raw);
      if (!state.autoReceipt || state.receipts.has(hash)) return hash;
      const name = tx.data && tx.data !== "0x" ? decodeFunctionData({ abi: parseAbi(["function subscribe(uint256)", "function refund()"]), data: tx.data }).functionName : "transfer";
      const fee = (tx.gas ?? 0n) * (tx.gasPrice ?? 0n);
      if (state.revertNames.has(name)) {
        // A reverted transaction still consumes its nonce and pays the fee.
        state.receipts.set(hash, "reverted");
        state.balance -= fee;
        state.nonce += 1;
        return hash;
      }
      state.receipts.set(hash, "success");
      if (name === "subscribe") { state.balance -= (tx.value ?? 0n) + fee; state.credits += 10_000n; }
      if (name === "refund") { state.balance += state.credits * 100_000n * 10_000_000_000n - fee; state.credits = 0n; }
      if (name === "transfer") state.balance -= (tx.value ?? 0n) + fee;
      state.nonce += 1;
      return hash;
    },
    receipt: async (hash) => state.receipts.get(hash) ?? null,
  };
  void budget;
  return { chain, state, sent };
}

function deps() {
  const budget = budgetAddressFor("agent:agt_fund", MASTER)!;
  const c = fakeChain(budget);
  const store = new MemoryFundingStore();
  let pending = false;
  const d = { chain: c.chain, vault: VAULT as `0x${string}`, budgetMaster: () => MASTER, store, paymentPending: async () => pending, sleep: async () => {} };
  return { d, c, store, budget, setPending: (v: boolean) => { pending = v; } };
}

describe("personal agent funding", () => {
  it("quotes the plan price plus a gas reserve and refuses team agents", async () => {
    const { d, c, budget } = deps();
    c.state.balance = 5n * HBAR;
    const quote = await fundingQuote(d, agent());
    expect(quote).toMatchObject({ budgetAddress: budget, priceHbar: "10", gasReserveHbar: "0.213", requiredHbar: "10.213", balanceHbar: "5", shortfallHbar: "5.213", planCredits: "10000", credits: "0" });
    await expect(fundingQuote(d, agent({ payerKind: "team", orgId: "org-1", budgetLabel: null }))).rejects.toMatchObject({ status: 409, type: "team_agent" });
    await expect(fundingQuote({ ...d, budgetMaster: () => undefined }, agent())).rejects.toMatchObject({ status: 503 });
  });

  it("keeps a too-small deposit as HBAR, then buys credits by signing from the derived budget account", async () => {
    const { d, c, budget } = deps();
    c.state.balance = 10n * HBAR;
    await expect(buyAgentCredits(d, agent())).rejects.toMatchObject({ status: 402, type: "insufficient_funds" });
    expect(c.sent).toHaveLength(0);

    c.state.balance = 11n * HBAR;
    const op = await buyAgentCredits(d, agent());
    expect(op).toMatchObject({ kind: "buy_credits", state: "confirmed", terms: { creditsBefore: "0", creditsAfter: "10000", budgetAddress: budget } });
    const tx = parseTransaction(op.legs[0].raw);
    expect(tx).toMatchObject({ chainId: 296, to: VAULT, value: 10n * HBAR, nonce: 4, gas: 300_000n, gasPrice: GAS_PRICE });
    expect(decodeFunctionData({ abi: parseAbi(["function subscribe(uint256 planId)"]), data: tx.data! })).toMatchObject({ functionName: "subscribe", args: [0n] });
    expect((await recoverTransactionAddress({ serializedTransaction: op.legs[0].raw as any })).toLowerCase()).toBe(budget.toLowerCase());
  });

  it("resumes an unconfirmed purchase with the same signed bytes instead of buying twice", async () => {
    const { d, c } = deps();
    c.state.balance = 25n * HBAR;
    c.state.autoReceipt = false;
    const pending = await buyAgentCredits(d, agent());
    expect(pending.state).toBe("uncertain");
    c.state.autoReceipt = true;
    const resumed = await buyAgentCredits(d, agent());
    expect(resumed.state).toBe("confirmed");
    expect(new Set(c.sent)).toEqual(new Set([pending.legs[0].raw]));
    expect(c.state.credits).toBe(10_000n);
  });

  it("refunds unused credits, sends the balance to the owner's wallet, and never repeats a confirmed refund", async () => {
    const { d, c, setPending } = deps();
    c.state.balance = 11n * HBAR;
    await buyAgentCredits(d, agent());
    setPending(true);
    await expect(returnAgentFunds(d, agent(), OWNER_WALLET)).rejects.toMatchObject({ status: 409, type: "payment_pending" });
    setPending(false);

    c.state.revertNames.add("transfer");
    const failed = await returnAgentFunds(d, agent(), OWNER_WALLET);
    expect(failed.state).toBe("reverted");
    expect(failed.legs.map((l) => [l.name, l.status])).toEqual([["refund", "success"], ["transfer", "reverted"]]);
    expect(c.state.credits).toBe(0n);

    // A reverted operation is closed; a fresh return has nothing to refund and only transfers.
    c.state.revertNames.clear();
    const retried = await returnAgentFunds(d, agent(), OWNER_WALLET);
    expect(retried.state).toBe("confirmed");
    expect(retried.legs.map((l) => l.name)).toEqual(["transfer"]);
    const transfer = parseTransaction(retried.legs[0].raw);
    expect(transfer.to?.toLowerCase()).toBe(OWNER_WALLET);
    expect(c.state.balance).toBe(0n);
    await expect(returnAgentFunds(d, agent(), "not-a-wallet")).rejects.toMatchObject({ status: 400 });
  });

  it("continues an interrupted return from the stored refund without refunding again", async () => {
    const { d, c } = deps();
    c.state.balance = 11n * HBAR;
    await buyAgentCredits(d, agent());
    c.state.autoReceipt = false;
    const interrupted = await returnAgentFunds(d, agent(), OWNER_WALLET);
    expect(interrupted.state).toBe("uncertain");
    expect(interrupted.legs.map((l) => l.name)).toEqual(["refund"]);
    await expect(returnAgentFunds(d, agent(), `0x${"12".repeat(20)}`)).rejects.toMatchObject({ status: 409 });
    c.state.autoReceipt = true;
    const done = await returnAgentFunds(d, agent(), OWNER_WALLET);
    expect(done.state).toBe("confirmed");
    expect(done.legs.map((l) => [l.name, l.status])).toEqual([["refund", "success"], ["transfer", "success"]]);
    // The refund may be rebroadcast, but only one subscribe and one refund transaction ever exist.
    expect(new Set(c.sent.filter((raw) => parseTransaction(raw).data && parseTransaction(raw).data !== "0x")).size).toBe(2);
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("durable funding operations", () => {
  const pool = new Pool({ connectionString: database });
  const store = new PgFundingStore(pool);
  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM agents WHERE id = 'agt_fund_pg'`);
    await pool.query(
      `INSERT INTO agents (id, name, owner_user_id, payer_kind, budget_label, state, policy, created_at, updated_at) VALUES ('agt_fund_pg', 'PG', 'did:privy:fund', 'personal', 'agent:agt_fund_pg', 'ready', '{}', 1, 1)`,
    );
  });
  afterAll(async () => {
    await pool.end();
  });

  it("allows one open operation per agent and keeps stored legs", async () => {
    const op = (id: string): FundingOp => ({ id, agentId: "agt_fund_pg", kind: "buy_credits", state: "signed", legs: [{ name: "subscribe", raw: "0x01", hash: "0x02", status: "signed" }], terms: { planId: "0" }, error: null, createdAt: 1, updatedAt: 1 });
    await store.insert(op("fop-1"));
    await expect(store.insert(op("fop-2"))).rejects.toMatchObject({ status: 409 });
    expect(await store.open("agt_fund_pg")).toMatchObject({ id: "fop-1", legs: [{ name: "subscribe", raw: "0x01" }] });
    expect(await store.update("fop-1", { state: "confirmed", error: null })).toMatchObject({ state: "confirmed", legs: [{ raw: "0x01" }] });
    expect(await store.open("agt_fund_pg")).toBeNull();
    await store.insert(op("fop-3"));
    expect((await store.recent("agt_fund_pg")).map((o) => o.id).sort()).toEqual(["fop-1", "fop-3"]);
  });
});
