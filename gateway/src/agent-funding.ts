import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { encodeFunctionData, formatEther, getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { deriveBudgetKey } from "./budget.js";
import { db } from "./db.js";
import type { Agent } from "./agents.js";
import type { TreasuryChain } from "./treasury.js";

// Personal agent budgets. The owner deposits HBAR into the agent's budget
// account from their own wallet; the broker then buys vault credits by signing
// subscribe with the budget key derived from BUDGET_MASTER (Key Ring in
// production). Returning funds refunds unused credits and sends the HBAR to one
// of the owner's verified wallets. Every leg's signed bytes are stored before
// broadcast, so a retry resumes the same operation and never repeats a leg.

export const HEDERA_TESTNET_CHAIN_ID = 296;
const WEIBAR_PER_TINYBAR = 10_000_000_000n;
const SUBSCRIBE_GAS = 300_000n;
const REFUND_GAS = 200_000n;
const TRANSFER_GAS = 50_000n;
const VAULT_ABI = parseAbi(["function subscribe(uint256 planId) payable", "function refund()"]);

export class FundingError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
  }
}

export type FundingKind = "buy_credits" | "return_funds";
export type FundingState = "signed" | "submitted" | "confirmed" | "reverted" | "uncertain" | "failed";

export interface FundingLeg {
  name: "subscribe" | "refund" | "transfer";
  raw: Hex;
  hash: Hex;
  status: "signed" | "submitted" | "success" | "reverted";
}

export interface FundingOp {
  id: string;
  agentId: string;
  kind: FundingKind;
  state: FundingState;
  legs: FundingLeg[];
  terms: Record<string, string>;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FundingStore {
  open(agentId: string): Promise<FundingOp | null>;
  insert(op: FundingOp): Promise<void>;
  update(id: string, patch: Partial<Pick<FundingOp, "state" | "legs" | "terms" | "error">>): Promise<FundingOp>;
  recent(agentId: string, limit?: number): Promise<FundingOp[]>;
}

const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
function rowToOp(r: any): FundingOp {
  return {
    id: r.id,
    agentId: r.agent_id,
    kind: r.kind,
    state: r.state,
    legs: json(r.legs) ?? [],
    terms: json(r.terms) ?? {},
    error: r.error ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class PgFundingStore implements FundingStore {
  constructor(private pool: Pick<Pool, "query"> = db()) {}

  async open(agentId: string): Promise<FundingOp | null> {
    const { rows } = await this.pool.query(`SELECT * FROM agent_funding_ops WHERE agent_id = $1 AND state IN ('signed', 'submitted', 'uncertain')`, [agentId]);
    return rows[0] ? rowToOp(rows[0]) : null;
  }

  async insert(op: FundingOp): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO agent_funding_ops (id, agent_id, kind, state, legs, terms, error, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [op.id, op.agentId, op.kind, op.state, JSON.stringify(op.legs), JSON.stringify(op.terms), op.error, op.createdAt, op.updatedAt],
      );
    } catch (e: any) {
      if (e?.code === "23505") throw new FundingError(409, "funding_busy", "Finish the agent's open funding operation first.");
      throw e;
    }
  }

  async update(id: string, patch: Partial<Pick<FundingOp, "state" | "legs" | "terms" | "error">>): Promise<FundingOp> {
    const { rows } = await this.pool.query(
      `UPDATE agent_funding_ops SET state = COALESCE($2, state), legs = COALESCE($3, legs), terms = COALESCE($4, terms),
         error = CASE WHEN $5::boolean THEN $6 ELSE error END, updated_at = $7 WHERE id = $1 RETURNING *`,
      [id, patch.state ?? null, patch.legs ? JSON.stringify(patch.legs) : null, patch.terms ? JSON.stringify(patch.terms) : null, "error" in patch, patch.error ?? null, Date.now()],
    );
    return rowToOp(rows[0]);
  }

  async recent(agentId: string, limit = 10): Promise<FundingOp[]> {
    const { rows } = await this.pool.query(`SELECT * FROM agent_funding_ops WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`, [agentId, limit]);
    return rows.map(rowToOp);
  }
}

export interface FundingDeps {
  chain: TreasuryChain;
  vault: Address;
  budgetMaster: () => string | undefined;
  store: FundingStore;
  /// @notice True while the payer has an in-flight or unresolved inference payment.
  paymentPending(payer: string): Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

const hbar = (weibar: bigint) => formatEther(weibar);

function budgetAccount(d: FundingDeps, agent: Agent): PrivateKeyAccount {
  if (agent.payerKind !== "personal" || !agent.budgetLabel) {
    throw new FundingError(409, "team_agent", "Team agents spend team credits. Fund the team treasury instead.");
  }
  const master = d.budgetMaster();
  if (!master) throw new FundingError(503, "broker_unavailable", "The budget key is unavailable. Try again later.");
  return privateKeyToAccount(deriveBudgetKey(master as Hex, agent.budgetLabel));
}

/// @notice What buying a plan costs from this agent's budget account right now.
export async function fundingQuote(d: FundingDeps, agent: Agent, planId = 0n) {
  const account = budgetAccount(d, agent);
  const [plan, balance, credits, gasPrice, open] = await Promise.all([
    d.chain.plan(planId), d.chain.balanceWei(account.address), d.chain.credits(account.address), d.chain.gasPrice(), d.store.open(agent.id),
  ]);
  if (!plan) throw new FundingError(409, "plan_unavailable", "That vault plan is not available.");
  const price = plan.priceTinybar * WEIBAR_PER_TINYBAR;
  const reserve = SUBSCRIBE_GAS * gasPrice;
  const required = price + reserve;
  return {
    network: "hedera-testnet",
    budgetAddress: account.address,
    planId: String(planId),
    planCredits: String(plan.credits),
    priceHbar: hbar(price),
    gasReserveHbar: hbar(reserve),
    requiredHbar: hbar(required),
    balanceHbar: hbar(balance),
    shortfallHbar: hbar(balance >= required ? 0n : required - balance),
    credits: String(credits),
    openOperation: open,
  };
}

async function sign(account: PrivateKeyAccount, name: FundingLeg["name"], tx: { to: Address; value: bigint; data?: Hex; nonce: number; gas: bigint; gasPrice: bigint }): Promise<FundingLeg> {
  const raw = await account.signTransaction({ chainId: HEDERA_TESTNET_CHAIN_ID, to: tx.to, value: tx.value, data: tx.data, nonce: tx.nonce, gas: tx.gas, gasPrice: tx.gasPrice, type: "legacy" });
  return { name, raw, hash: keccak256(raw), status: "signed" };
}

/// @notice Broadcast pending legs in order by their stored bytes and record receipts.
async function settle(d: FundingDeps, op: FundingOp): Promise<FundingOp> {
  const legs = op.legs.map((l) => ({ ...l }));
  for (const leg of legs) {
    if (leg.status === "success") continue;
    if (leg.status === "reverted") return d.store.update(op.id, { state: "reverted", legs, error: `The ${leg.name} transaction reverted.` });
    let status = await d.chain.receipt(leg.hash);
    if (!status) {
      await d.chain.sendRaw(leg.raw).catch(() => undefined); // may already be known; the receipt decides
      leg.status = "submitted";
      await d.store.update(op.id, { state: "submitted", legs });
      for (let attempt = 0; attempt < 30 && !status; attempt++) {
        await (d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(2000);
        status = await d.chain.receipt(leg.hash);
      }
    }
    if (!status) return d.store.update(op.id, { state: "uncertain", legs, error: `No receipt yet for the ${leg.name} transaction. Retry to check the same transaction.` });
    leg.status = status === "success" ? "success" : "reverted";
    if (status === "reverted") return d.store.update(op.id, { state: "reverted", legs, error: `The ${leg.name} transaction reverted.` });
    op = await d.store.update(op.id, { legs, error: null });
  }
  return op;
}

/// @notice Buy vault credits from the agent's budget account. A retry resumes the open purchase.
export async function buyAgentCredits(d: FundingDeps, agent: Agent, planId = 0n): Promise<FundingOp> {
  const account = budgetAccount(d, agent);
  const open = await d.store.open(agent.id);
  if (open) {
    if (open.kind !== "buy_credits") throw new FundingError(409, "funding_busy", "Finish returning this agent's funds first.");
    const settled = await settle(d, open);
    return settled.legs.every((l) => l.status === "success") ? d.store.update(open.id, { state: "confirmed", terms: { ...settled.terms, creditsAfter: String(await d.chain.credits(account.address)) } }) : settled;
  }
  const plan = await d.chain.plan(planId);
  if (!plan) throw new FundingError(409, "plan_unavailable", "That vault plan is not available.");
  const price = plan.priceTinybar * WEIBAR_PER_TINYBAR;
  const [balance, gasPrice, nonce, creditsBefore] = await Promise.all([d.chain.balanceWei(account.address), d.chain.gasPrice(), d.chain.nonce(account.address), d.chain.credits(account.address)]);
  const fee = SUBSCRIBE_GAS * gasPrice;
  if (balance < price + fee) {
    throw new FundingError(402, "insufficient_funds", `Deposit at least ${hbar(price + fee - balance)} more HBAR into the agent budget. Deposits stay HBAR until credits are bought.`);
  }
  const leg = await sign(account, "subscribe", { to: getAddress(d.vault), value: price, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "subscribe", args: [planId] }), nonce, gas: SUBSCRIBE_GAS, gasPrice });
  const now = Date.now();
  const op: FundingOp = {
    id: `fop_${randomUUID()}`, agentId: agent.id, kind: "buy_credits", state: "signed", legs: [leg],
    terms: { budgetAddress: account.address, planId: String(planId), priceHbar: hbar(price), planCredits: String(plan.credits), maxFeeHbar: hbar(fee), creditsBefore: String(creditsBefore) },
    error: null, createdAt: now, updatedAt: now,
  };
  await d.store.insert(op);
  const settled = await settle(d, op);
  if (!settled.legs.every((l) => l.status === "success")) return settled;
  return d.store.update(op.id, { state: "confirmed", terms: { ...settled.terms, creditsAfter: String(await d.chain.credits(account.address)) } });
}

/// @notice Refund unused credits and send the budget's HBAR to the owner's verified wallet.
/// The caller verifies the owner session, the destination, and any required Ledger approval.
export async function returnAgentFunds(d: FundingDeps, agent: Agent, destination: string): Promise<FundingOp> {
  const account = budgetAccount(d, agent);
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) throw new FundingError(400, "invalid_request", "Choose one of your wallets as the destination.");
  let op = await d.store.open(agent.id);
  if (op && op.kind !== "return_funds") throw new FundingError(409, "funding_busy", "Finish buying credits for this agent first.");
  if (op && op.terms.destination?.toLowerCase() !== destination.toLowerCase()) {
    throw new FundingError(409, "funding_busy", "A return to another wallet is already in progress. Retry with the same destination.");
  }
  if (!op) {
    if (await d.paymentPending(account.address)) {
      throw new FundingError(409, "payment_pending", "Credits are reserved by an in-flight or unresolved request. Return funds after it settles.");
    }
    const [credits, gasPrice, nonce] = await Promise.all([d.chain.credits(account.address), d.chain.gasPrice(), d.chain.nonce(account.address)]);
    const legs = credits > 0n ? [await sign(account, "refund", { to: getAddress(d.vault), value: 0n, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "refund" }), nonce, gas: REFUND_GAS, gasPrice })] : [];
    const now = Date.now();
    op = {
      id: `fop_${randomUUID()}`, agentId: agent.id, kind: "return_funds", state: "signed", legs,
      terms: { budgetAddress: account.address, destination: getAddress(destination), refundedCredits: String(credits), nextNonce: String(nonce + legs.length), gasPrice: String(gasPrice) },
      error: null, createdAt: now, updatedAt: now,
    };
    await d.store.insert(op);
  }
  op = await settle(d, op);
  if (!op.legs.every((l) => l.status === "success")) return op;
  // The transfer leg is signed only after any refund confirmed, and never twice.
  if (!op.legs.some((l) => l.name === "transfer")) {
    const gasPrice = BigInt(op.terms.gasPrice);
    const fee = TRANSFER_GAS * gasPrice;
    const balance = await d.chain.balanceWei(account.address);
    if (balance <= fee) return d.store.update(op.id, { state: "confirmed", terms: { ...op.terms, returnedHbar: "0" }, error: null });
    const leg = await sign(account, "transfer", { to: getAddress(destination), value: balance - fee, nonce: Number(op.terms.nextNonce), gas: TRANSFER_GAS, gasPrice });
    op = await d.store.update(op.id, { legs: [...op.legs, leg], terms: { ...op.terms, returnedHbar: hbar(balance - fee) } });
    op = await settle(d, op);
    if (!op.legs.every((l) => l.status === "success")) return op;
  }
  return d.store.update(op.id, { state: "confirmed", error: null });
}
