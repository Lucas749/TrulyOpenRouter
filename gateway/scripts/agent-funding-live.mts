// Real-world personal agent funding check on Hedera testnet (opt-in, spends test HBAR fees).
//
// Uses a throwaway budget master kept in .local, so no production budget account is
// touched. Verifies on chain: a deposit below plan price + fee is refused without
// broadcasting; the broker buys a plan by signing subscribe with the derived budget
// key; returning refunds the credits and sends the HBAR back to the funder.
//
//   LIVE_FUNDER_KEY=0x<testnet key with >=12 HBAR> npx tsx scripts/agent-funding-live.mts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buyAgentCredits, fundingQuote, returnAgentFunds, type FundingOp, type FundingStore } from "../src/agent-funding.js";
import { normalizePolicy, type Agent } from "../src/agents.js";
import { budgetAddressFor } from "../src/budget.js";
import { hederaTreasuryChain } from "../src/treasury.js";

const RPC = process.env.RPC_URL ?? "https://testnet.hashio.io/api";
const VAULT = (process.env.VAULT_ADDRESS ?? "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576") as `0x${string}`;
const FUNDER_KEY = process.env.LIVE_FUNDER_KEY as Hex | undefined;
const STATE = process.env.LIVE_STATE ?? join(process.cwd(), "..", ".local", "live-agent-funding.json");
if (!FUNDER_KEY) throw new Error("Set LIVE_FUNDER_KEY (testnet only).");

const HBAR = 10n ** 18n;
const chain = defineChain({ id: 296, name: "Hedera Testnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const funder = privateKeyToAccount(FUNDER_KEY);
const pub = createPublicClient({ chain, transport: http(RPC) });

const state: Record<string, string> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
if (!state.master) {
  state.master = `0x${randomBytes(32).toString("hex")}`;
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

class MemoryStore implements FundingStore {
  rows = new Map<string, FundingOp>();
  async open(agentId: string) {
    return [...this.rows.values()].find((o) => o.agentId === agentId && ["signed", "submitted", "uncertain"].includes(o.state)) ?? null;
  }
  async insert(op: FundingOp) {
    this.rows.set(op.id, structuredClone(op));
  }
  async update(id: string, patch: Partial<FundingOp>) {
    const row = Object.assign(this.rows.get(id)!, structuredClone(patch), { updatedAt: Date.now() });
    return structuredClone(row);
  }
  async recent(agentId: string) {
    return [...this.rows.values()].filter((o) => o.agentId === agentId);
  }
}

const agent: Agent = {
  id: "agt_live_funding", name: "Live funding check", description: "", ownerUserId: "did:privy:live", orgId: null, sponsorDid: null, payerKind: "personal",
  budgetLabel: "agent:agt_live_funding", state: "ready", policy: normalizePolicy({}), policyRevision: 1, ledgerAddress: null, ledgerRevision: 0, createdAt: 0, updatedAt: 0,
};
const d = { chain: hederaTreasuryChain(RPC, VAULT), vault: VAULT, budgetMaster: () => state.master, store: new MemoryStore(), paymentPending: async () => false };
const budget = budgetAddressFor(agent.budgetLabel!, state.master)! as `0x${string}`;

let failures = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
};

let quote = await fundingQuote(d, agent);
console.log(`budget ${budget} balance ${quote.balanceHbar} HBAR, credits ${quote.credits}; plan needs ${quote.requiredHbar} HBAR`);
check(quote.budgetAddress === budget, "quote uses the derived budget account");

if (Number(quote.shortfallHbar) > 0) {
  const refused = await buyAgentCredits(d, agent).then(() => null, (e) => e);
  check(refused?.status === 402, `a balance below price + fee is refused before signing (${refused?.type})`);
  const top = BigInt(Math.ceil(Number(quote.shortfallHbar) * 1e8)) * 10_000_000_000n + HBAR / 2n;
  const hash = await createWalletClient({ account: funder, chain, transport: http(RPC) }).sendTransaction({ to: budget, value: top });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`deposited ${formatEther(top)} HBAR from ${funder.address} (${hash})`);
  quote = await fundingQuote(d, agent);
}

const bought = await buyAgentCredits(d, agent);
const buyTx = parseTransaction(bought.legs[0].raw);
console.log(`buy ${bought.legs[0].hash} -> ${bought.state}; credits ${bought.terms.creditsBefore} -> ${bought.terms.creditsAfter}`);
check(bought.state === "confirmed" && BigInt(bought.terms.creditsAfter) - BigInt(bought.terms.creditsBefore) === BigInt(quote.planCredits), "subscribe settled and credited the plan");
check((await recoverTransactionAddress({ serializedTransaction: bought.legs[0].raw as any })).toLowerCase() === budget.toLowerCase(), "subscribe was signed by the budget account");
check(buyTx.chainId === 296 && buyTx.to?.toLowerCase() === VAULT.toLowerCase(), "subscribe targets the vault on chain 296");

const returned = await returnAgentFunds(d, agent, funder.address);
for (const leg of returned.legs) console.log(`${leg.name} ${leg.hash} -> ${leg.status}`);
check(returned.state === "confirmed" && returned.legs.map((l) => l.name).join(",") === "refund,transfer", "return refunded credits, then transferred HBAR");
const [creditsLeft, balanceLeft] = await Promise.all([d.chain.credits(budget), pub.getBalance({ address: budget })]);
console.log(`returned ${returned.terms.returnedHbar} HBAR to ${funder.address}; budget now ${formatEther(balanceLeft)} HBAR, ${creditsLeft} credits`);
check(creditsLeft === 0n, "no credits remain in the vault for the budget account");
check(balanceLeft < HBAR / 10n, "less than 0.1 HBAR fee dust remains in the budget account");

console.log(failures ? `${failures} FAILURE(S)` : "ALL LIVE AGENT FUNDING CHECKS PASSED");
process.exit(failures ? 1 : 0);
