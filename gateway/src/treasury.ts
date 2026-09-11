import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { formatRequestForAuthorizationSignature, generateAuthorizationSignature, generateAuthorizationSignatures, PrivyClient } from "@privy-io/node";
import { createPublicClient, encodeFunctionData, formatEther, formatUnits, getAddress, http, keccak256, parseAbi, parseTransaction, toHex, type Address, type Hex } from "viem";
import type { Pool } from "pg";
import { db } from "./db.js";
import type { Identity, PgTeams, Team, TeamMember } from "./teams.js";

// Team treasury: a Privy organization wallet owned by a 2-of-2 key quorum of the
// team's financial approver (Privy user authorization) and the broker's P-256
// authorization key. The broker key alone cannot satisfy the quorum, so every
// transaction needs the approver's live session. Transactions are prepared in
// full before approval, signed through a Privy intent (eth_signTransaction),
// stored, then broadcast to Hedera and confirmed from the receipt.

export const HEDERA_TESTNET_CHAIN_ID = 296;
const WEIBAR_PER_TINYBAR = 10_000_000_000n;
/// HTS test USDC 0.0.429274 through its ERC-20 facade (long-zero address).
export const TEST_USDC_ADDRESS = "0x0000000000000000000000000000000000068cda" as Address;

const VAULT_ABI = parseAbi([
  "function subscribe(uint256 planId) payable",
  "function refund()",
  "function credits(address) view returns (uint256)",
  "function plans(uint256) view returns (uint256 priceWei, uint256 credits, bool exists)",
]);
const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
// Privy policy conditions take strict JSON ABIs.
const SUBSCRIBE_JSON_ABI = [{ type: "function", name: "subscribe", stateMutability: "payable", inputs: [{ name: "planId", type: "uint256" }], outputs: [] }];
const REFUND_JSON_ABI = [{ type: "function", name: "refund", stateMutability: "nonpayable", inputs: [], outputs: [] }];
const TRANSFER_JSON_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }];

export class TreasuryError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
  }
}

export class PrivyRequestError extends Error {
  constructor(public status: number, public body: string) {
    super(`Privy request failed (${status})`);
  }
}

// --- Keys and external services ---------------------------------------------

export interface BrokerKey {
  privateKey: string; // base64 PKCS8 P-256, no PEM headers
  publicKey: string; // base64 DER SPKI, as registered on the quorum
}

/// @notice Broker authorization key from its private half (Key Ring in production).
export function brokerKey(privateKeyB64: string): BrokerKey {
  const privateKey = privateKeyB64.replace(/^wallet-auth:/, "").trim();
  const key = createPrivateKey({ key: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`, format: "pem" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Broker authorization key must be P-256");
  return { privateKey, publicKey: createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") };
}

export interface PrivyAccess {
  appId: string;
  request<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /// @notice Authorization signatures over a payload from the user behind this access token (Privy JWT exchange).
  userSignatures(jwt: string, payload: Record<string, unknown>): Promise<string[]>;
}

export function privyAccess(appId: string, appSecret: string): PrivyAccess {
  const client = new PrivyClient({ appId, appSecret });
  const authorization = "Basic " + Buffer.from(`${appId}:${appSecret}`).toString("base64");
  return {
    appId,
    async request(method, path, body) {
      const res = await fetch(`https://api.privy.io/v1${path}`, {
        method,
        headers: { "privy-app-id": appId, Authorization: authorization, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (!res.ok) throw new PrivyRequestError(res.status, text.slice(0, 400));
      return text ? JSON.parse(text) : {};
    },
    userSignatures: (jwt, payload) => generateAuthorizationSignatures(client, { authorizationContext: { user_jwts: [jwt] }, input: payload as any }),
  };
}

export interface TreasuryChain {
  plan(planId: bigint): Promise<{ priceTinybar: bigint; credits: bigint } | null>;
  credits(address: Address): Promise<bigint>;
  balanceWei(address: Address): Promise<bigint>;
  tokenBalance(token: Address, address: Address): Promise<bigint>;
  nonce(address: Address): Promise<number>;
  gasPrice(): Promise<bigint>;
  estimateGas(tx: { from: Address; to: Address; value: bigint; data: Hex }): Promise<bigint>;
  sendRaw(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<"success" | "reverted" | null>;
}

export function hederaTreasuryChain(rpcUrl: string, vault: Address): TreasuryChain {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async plan(planId) {
      const [priceWei, credits, exists] = await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "plans", args: [planId] });
      return exists ? { priceTinybar: priceWei, credits } : null;
    },
    credits: (address) => client.readContract({ address: vault, abi: VAULT_ABI, functionName: "credits", args: [address] }),
    balanceWei: (address) => client.getBalance({ address }),
    tokenBalance: (token, address) => client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
    nonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    gasPrice: () => client.getGasPrice(),
    estimateGas: (tx) => client.estimateGas({ account: tx.from, to: tx.to, value: tx.value, data: tx.data }),
    sendRaw: (raw) => client.sendRawTransaction({ serializedTransaction: raw }),
    async receipt(hash) {
      try {
        return (await client.getTransactionReceipt({ hash })).status;
      } catch {
        return null;
      }
    },
  };
}

// --- Policy ------------------------------------------------------------------

export interface TreasuryPolicyInput {
  vault: Address;
  plans: Array<{ planId: bigint; priceTinybar: bigint }>;
  recipients: string[];
  hbarPayoutCapWei: bigint;
  usdcPayoutCapUnits: bigint;
}

/// @notice Allow-list policy for the team wallet. Anything not matched is denied by Privy.
export function treasuryPolicyRules(p: TreasuryPolicyInput) {
  const chain = { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(HEDERA_TESTNET_CHAIN_ID) };
  const vault = getAddress(p.vault);
  const recipients = p.recipients.map((r) => getAddress(r));
  const rules: Array<Record<string, unknown>> = p.plans.map((plan) => ({
    name: `buy-credits-plan-${plan.planId}`,
    method: "eth_signTransaction",
    action: "ALLOW",
    conditions: [
      chain,
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: vault },
      { field_source: "ethereum_transaction", field: "value", operator: "eq", value: String(plan.priceTinybar * WEIBAR_PER_TINYBAR) },
      { field_source: "ethereum_calldata", field: "subscribe.planId", abi: SUBSCRIBE_JSON_ABI, operator: "eq", value: String(plan.planId) },
    ],
  }));
  rules.push({
    name: "refund-credits",
    method: "eth_signTransaction",
    action: "ALLOW",
    conditions: [
      chain,
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: vault },
      { field_source: "ethereum_transaction", field: "value", operator: "eq", value: "0" },
      { field_source: "ethereum_calldata", field: "function_name", abi: REFUND_JSON_ABI, operator: "eq", value: "refund" },
    ],
  });
  if (recipients.length) {
    rules.push({
      name: "payout-hbar",
      method: "eth_signTransaction",
      action: "ALLOW",
      conditions: [
        chain,
        { field_source: "ethereum_transaction", field: "to", operator: "in", value: recipients },
        { field_source: "ethereum_transaction", field: "value", operator: "lte", value: String(p.hbarPayoutCapWei) },
      ],
    });
    rules.push({
      name: "payout-test-usdc",
      method: "eth_signTransaction",
      action: "ALLOW",
      conditions: [
        chain,
        { field_source: "ethereum_transaction", field: "to", operator: "eq", value: getAddress(TEST_USDC_ADDRESS) },
        { field_source: "ethereum_transaction", field: "value", operator: "eq", value: "0" },
        { field_source: "ethereum_calldata", field: "transfer.to", abi: TRANSFER_JSON_ABI, operator: "in", value: recipients },
        { field_source: "ethereum_calldata", field: "transfer.amount", abi: TRANSFER_JSON_ABI, operator: "lte", value: String(p.usdcPayoutCapUnits) },
      ],
    });
  }
  return rules;
}

// --- Persistence -------------------------------------------------------------

export type IntentKind = "buy_credits" | "refund" | "payout_hbar" | "payout_usdc" | "update_policy";
export type IntentState =
  | "proposed" | "awaiting_approvals" | "authorized" | "signed" | "submitted" | "confirmed"
  | "denied" | "expired" | "reverted" | "cancelled" | "uncertain" | "failed";

export interface PreparedTransaction {
  chain_id: number;
  to: Address;
  value: Hex;
  data: Hex;
  nonce: number;
  gas_limit: Hex;
  gas_price: Hex;
  type: 0;
}

export interface IntentApproval {
  by: string;
  method: "privy_user" | "broker_key";
  at: number;
}

/// @notice The exact policy rules an owner proposes and the limits they encode.
export interface PolicyChange {
  policyId: string;
  rules: Array<Record<string, unknown>>;
  limits: { planIds: string[]; hbarPayoutCapWei: string; usdcPayoutCapUnits: string; payoutRecipients: string[] };
}

export interface TreasuryIntent {
  id: string;
  orgId: string;
  kind: IntentKind;
  privyIntentId: string | null;
  walletAddress: string;
  transaction: PreparedTransaction; // empty for policy changes
  policyChange: PolicyChange | null;
  terms: Record<string, string>;
  actionHash: string;
  state: IntentState;
  proposedBy: string;
  approvals: IntentApproval[];
  signedTransaction: string | null;
  transactionHash: string | null;
  result: Record<string, string>;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TreasuryStore {
  insert(intent: TreasuryIntent): Promise<void>;
  get(id: string): Promise<TreasuryIntent | null>;
  list(orgId: string, limit?: number): Promise<TreasuryIntent[]>;
  /// @notice Conditional update: applies only while the stored state is one of `from`.
  transition(id: string, from: IntentState[], patch: Partial<TreasuryIntent>): Promise<TreasuryIntent | null>;
}

const OPEN_STATES: IntentState[] = ["proposed", "awaiting_approvals", "authorized", "signed", "submitted", "uncertain"];

function rowToIntent(r: any): TreasuryIntent {
  const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind,
    privyIntentId: r.privy_intent_id ?? null,
    walletAddress: r.wallet_address,
    transaction: json(r.transaction),
    policyChange: json(r.policy_change) ?? null,
    terms: json(r.terms),
    actionHash: r.action_hash,
    state: r.state,
    proposedBy: r.proposed_by,
    approvals: json(r.approvals) ?? [],
    signedTransaction: r.signed_transaction ?? null,
    transactionHash: r.transaction_hash ?? null,
    result: json(r.result) ?? {},
    error: r.error ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const COLUMNS: Partial<Record<keyof TreasuryIntent, string>> = {
  privyIntentId: "privy_intent_id",
  state: "state",
  approvals: "approvals",
  signedTransaction: "signed_transaction",
  transactionHash: "transaction_hash",
  result: "result",
  error: "error",
};

export class PgTreasuryStore implements TreasuryStore {
  constructor(private pool: Pick<Pool, "query"> = db()) {}

  async insert(i: TreasuryIntent): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO treasury_intents (id, org_id, kind, privy_intent_id, wallet_address, transaction, terms, action_hash, state, proposed_by,
           approvals, signed_transaction, transaction_hash, result, error, created_at, updated_at, policy_change)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [i.id, i.orgId, i.kind, i.privyIntentId, i.walletAddress, JSON.stringify(i.transaction), JSON.stringify(i.terms), i.actionHash, i.state,
          i.proposedBy, JSON.stringify(i.approvals), i.signedTransaction, i.transactionHash, JSON.stringify(i.result), i.error, i.createdAt, i.updatedAt,
          i.policyChange ? JSON.stringify(i.policyChange) : null],
      );
    } catch (e: any) {
      if (e?.code === "23505") throw new TreasuryError(409, "treasury_busy", "Finish or cancel the team's open treasury transaction first.");
      throw e;
    }
  }

  async get(id: string): Promise<TreasuryIntent | null> {
    const { rows } = await this.pool.query(`SELECT * FROM treasury_intents WHERE id = $1`, [id]);
    return rows[0] ? rowToIntent(rows[0]) : null;
  }

  async list(orgId: string, limit = 20): Promise<TreasuryIntent[]> {
    const { rows } = await this.pool.query(`SELECT * FROM treasury_intents WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`, [orgId, limit]);
    return rows.map(rowToIntent);
  }

  async transition(id: string, from: IntentState[], patch: Partial<TreasuryIntent>): Promise<TreasuryIntent | null> {
    const sets = ["updated_at = $3"];
    const values: unknown[] = [id, from, Date.now()];
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (!(key in patch)) continue;
      const v = (patch as any)[key];
      values.push(key === "approvals" || key === "result" ? JSON.stringify(v) : v);
      sets.push(`${column} = $${values.length}`);
    }
    const { rows } = await this.pool.query(`UPDATE treasury_intents SET ${sets.join(", ")} WHERE id = $1 AND state = ANY($2::text[]) RETURNING *`, values);
    return rows[0] ? rowToIntent(rows[0]) : null;
  }
}

// --- Service -----------------------------------------------------------------

export interface TreasuryDeps {
  privy: PrivyAccess;
  broker: BrokerKey;
  chain: TreasuryChain;
  vault: Address;
  planIds: bigint[];
  hbarPayoutCapWei: bigint;
  usdcPayoutCapUnits: bigint;
  teams: Pick<PgTeams, "team" | "setTeamWallet" | "setTreasuryLimits">;
  store: TreasuryStore;
  /// @notice True while this payer has an in-flight or unresolved inference payment.
  paymentPending(payer: string): Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const stripDid = (id: string | null | undefined) => String(id ?? "").replace(/^did:privy:/, "");
const hbar = (weibar: bigint) => formatEther(weibar);
const sleepFor = (d: TreasuryDeps) => d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
const nowFor = (d: TreasuryDeps) => (d.now ?? Date.now)();

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/// @notice Provision a policy-controlled team wallet and activate it only after
/// Privy reports the expected owner, policy, and 2-of-2 approver/broker quorum.
export async function provisionTeamWallet(d: TreasuryDeps, input: { name: string; approverUserId: string; recipients: string[] }): Promise<Team> {
  const name = input.name.trim();
  if (!name || name.length > 64) throw new TreasuryError(400, "invalid_request", "Team name is required (64 characters or fewer).");
  if (!/^did:privy:[A-Za-z0-9]+$/.test(input.approverUserId)) throw new TreasuryError(400, "invalid_request", "A verified financial approver is required.");
  const recipients = [...new Set(input.recipients.map((r) => r.toLowerCase()))];
  if (!recipients.length || recipients.some((r) => !/^0x[0-9a-f]{40}$/.test(r))) {
    throw new TreasuryError(400, "invalid_request", "At least one payout recipient wallet is required.");
  }
  const plans: Array<{ planId: bigint; priceTinybar: bigint }> = [];
  for (const planId of d.planIds) {
    const plan = await d.chain.plan(planId);
    if (plan) plans.push({ planId, priceTinybar: plan.priceTinybar });
  }
  if (!plans.length) throw new TreasuryError(503, "plans_unavailable", "No vault plan is available for team purchases.");
  const quorum = await d.privy.request("POST", "/key_quorums", {
    user_ids: [input.approverUserId],
    public_keys: [d.broker.publicKey],
    authorization_threshold: 2,
    display_name: `${name.slice(0, 40)} approvers`,
  });
  const org = await d.privy.request("POST", "/organizations", { display_name: name, default_key_quorum_id: quorum.id });
  const policy = await d.privy.request("POST", "/policies", {
    version: "1.0",
    name: `${name.slice(0, 40)} treasury`,
    chain_type: "ethereum",
    owner_id: quorum.id,
    rules: treasuryPolicyRules({ vault: d.vault, plans, recipients, hbarPayoutCapWei: d.hbarPayoutCapWei, usdcPayoutCapUnits: d.usdcPayoutCapUnits }),
  });
  const wallet = await d.privy.request("POST", "/wallets", { chain_type: "ethereum", entity: { id: org.id, type: "organization" }, policy_ids: [policy.id] });
  await verifyTeamWallet(d, { walletId: wallet.id, quorumId: quorum.id, policyId: policy.id, approverUserId: input.approverUserId });
  return d.teams.setTeamWallet(org.id, {
    name,
    walletId: wallet.id,
    walletAddress: wallet.address,
    quorumId: quorum.id,
    policyId: policy.id,
    approverUserId: input.approverUserId,
    payoutRecipients: recipients,
    limits: { planIds: plans.map((p) => String(p.planId)), hbarPayoutCapWei: String(d.hbarPayoutCapWei), usdcPayoutCapUnits: String(d.usdcPayoutCapUnits) },
  });
}

export async function verifyTeamWallet(d: Pick<TreasuryDeps, "privy" | "broker">, ids: { walletId: string; quorumId: string; policyId: string; approverUserId: string }): Promise<void> {
  const [wallet, quorum] = await Promise.all([
    d.privy.request("GET", `/wallets/${ids.walletId}`),
    d.privy.request("GET", `/key_quorums/${ids.quorumId}`),
  ]);
  const problems: string[] = [];
  const users: string[] = quorum.user_ids ?? [];
  const keys: Array<{ public_key: string }> = quorum.authorization_keys ?? [];
  if (wallet.owner_id !== ids.quorumId) problems.push("the wallet owner is not the approval quorum");
  if (!(wallet.policy_ids ?? []).includes(ids.policyId)) problems.push("the treasury policy is not attached");
  if ((wallet.additional_signers ?? []).length) problems.push("the wallet has additional signers");
  if (quorum.authorization_threshold !== 2) problems.push("the quorum threshold is not 2");
  if (!users.some((u) => stripDid(u) === stripDid(ids.approverUserId))) problems.push("the financial approver is not a quorum member");
  if (!keys.some((k) => k.public_key === d.broker.publicKey)) problems.push("the broker key is not a quorum member");
  if (users.length + keys.length !== 2 || (quorum.key_quorum_ids ?? []).length) problems.push("the quorum has unexpected members");
  if (problems.length) throw new TreasuryError(502, "wallet_unverified", `The team wallet is not safe to activate: ${problems.join("; ")}.`);
}

async function activeTeam(d: TreasuryDeps, orgId: string): Promise<Team & { walletId: string; walletAddress: string }> {
  const team = await d.teams.team(orgId);
  if (!team || team.state !== "active" || !team.walletId || !team.walletAddress) {
    throw new TreasuryError(409, "wallet_inactive", "This team has no active treasury wallet.");
  }
  return team as Team & { walletId: string; walletAddress: string };
}

export interface TreasuryLimits {
  planIds: bigint[];
  hbarPayoutCapWei: bigint;
  usdcPayoutCapUnits: bigint;
}

/// @notice The limits in this team's Privy policy. Teams created before per-team
/// limits carry the network defaults they were provisioned with.
export function teamLimits(d: Pick<TreasuryDeps, "planIds" | "hbarPayoutCapWei" | "usdcPayoutCapUnits">, team: Team): TreasuryLimits {
  const l = team.limits;
  return l
    ? { planIds: l.planIds.map((p) => BigInt(p)), hbarPayoutCapWei: BigInt(l.hbarPayoutCapWei), usdcPayoutCapUnits: BigInt(l.usdcPayoutCapUnits) }
    : { planIds: d.planIds, hbarPayoutCapWei: d.hbarPayoutCapWei, usdcPayoutCapUnits: d.usdcPayoutCapUnits };
}

export function teamLimitsView(d: Pick<TreasuryDeps, "planIds" | "hbarPayoutCapWei" | "usdcPayoutCapUnits">, team: Team) {
  const l = teamLimits(d, team);
  return { planIds: l.planIds.map(String), hbarPayoutCap: hbar(l.hbarPayoutCapWei), usdcPayoutCap: formatUnits(l.usdcPayoutCapUnits, 6), recipients: team.payoutRecipients };
}

function parseUnits(amount: unknown, decimals: number, label: string): bigint {
  const s = String(amount ?? "").trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(s)) throw new TreasuryError(400, "invalid_request", `${label} must be a positive amount with at most ${decimals} decimals.`);
  const [whole, frac = ""] = s.split(".");
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new TreasuryError(400, "invalid_request", `${label} must be positive.`);
  return units;
}

/// @notice Owners propose new wallet limits. The Privy policy changes only after the
/// financial approver and the broker key authorize the exact rules, as with a transaction.
async function proposePolicyChange(d: TreasuryDeps, team: Team & { walletId: string; walletAddress: string }, actor: TeamMember, params: Record<string, unknown>): Promise<TreasuryIntent> {
  if (actor.role !== "owner") throw new TreasuryError(403, "forbidden", "Only team owners can change the team wallet limits.");
  if (!team.policyId) throw new TreasuryError(409, "wallet_inactive", "This team wallet has no policy to change.");
  const requested = Array.isArray(params.planIds) ? params.planIds : [];
  const planIds = [...new Set(requested.map((p) => (Number.isSafeInteger(Number(p)) && Number(p) >= 0 ? BigInt(Number(p)) : -1n)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!planIds.length || planIds.some((p) => !d.planIds.includes(p))) {
    throw new TreasuryError(400, "invalid_request", "Allow at least one of the credit plans this network offers.");
  }
  const plans: Array<{ planId: bigint; priceTinybar: bigint }> = [];
  for (const planId of planIds) {
    const plan = await d.chain.plan(planId);
    if (!plan) throw new TreasuryError(409, "plan_unavailable", `Credit plan ${planId} is not available.`);
    plans.push({ planId, priceTinybar: plan.priceTinybar });
  }
  const hbarPayoutCapWei = parseUnits(params.hbarPayoutCap, 8, "The HBAR payout limit") * WEIBAR_PER_TINYBAR;
  const usdcPayoutCapUnits = parseUnits(params.usdcPayoutCap, 6, "The test USDC payout limit");
  const recipients = [...new Set((Array.isArray(params.recipients) ? params.recipients : []).map((r) => String(r).trim().toLowerCase()))];
  if (!recipients.length || recipients.length > 20 || recipients.some((r) => !/^0x[0-9a-f]{40}$/.test(r))) {
    throw new TreasuryError(400, "invalid_request", "List 1 to 20 payout recipient wallet addresses.");
  }
  const rules = treasuryPolicyRules({ vault: d.vault, plans, recipients, hbarPayoutCapWei, usdcPayoutCapUnits });
  const policyChange: PolicyChange = {
    policyId: team.policyId,
    rules,
    limits: { planIds: planIds.map(String), hbarPayoutCapWei: String(hbarPayoutCapWei), usdcPayoutCapUnits: String(usdcPayoutCapUnits), payoutRecipients: recipients },
  };
  const current = teamLimitsView(d, team);
  const terms: Record<string, string> = {
    action: "Change wallet limits",
    plans: planIds.join(", "),
    hbarPayoutCap: hbar(hbarPayoutCapWei),
    usdcPayoutCap: formatUnits(usdcPayoutCapUnits, 6),
    recipients: recipients.map((r) => getAddress(r)).join(", "),
    previous: `plans ${current.planIds.join(", ")} · ${current.hbarPayoutCap} HBAR · ${current.usdcPayoutCap} test USDC · ${current.recipients.length} recipient(s)`,
    wallet: getAddress(team.walletAddress),
    network: `Hedera testnet (${HEDERA_TESTNET_CHAIN_ID})`,
  };
  const at = nowFor(d);
  const intent: TreasuryIntent = {
    id: `trx_${randomUUID()}`,
    orgId: team.orgId,
    kind: "update_policy",
    privyIntentId: null,
    walletAddress: team.walletAddress,
    transaction: {} as PreparedTransaction, // a policy change carries no transaction
    policyChange,
    terms,
    actionHash: createHash("sha256").update(stable({ orgId: team.orgId, kind: "update_policy", policyChange, terms })).digest("hex"),
    state: "proposed",
    proposedBy: actor.did,
    approvals: [],
    signedTransaction: null,
    transactionHash: null,
    result: {},
    error: null,
    createdAt: at,
    updatedAt: at,
  };
  await d.store.insert(intent);
  try {
    const remote = await d.privy.request("PATCH", `/intents/policies/${team.policyId}`, { rules });
    return (await d.store.transition(intent.id, ["proposed"], { privyIntentId: remote.intent_id, state: "awaiting_approvals" }))!;
  } catch {
    await d.store.transition(intent.id, ["proposed"], { state: "failed", error: "Privy could not create the approval request." });
    throw new TreasuryError(502, "privy_unavailable", "Privy could not create the approval request. Try again.");
  }
}

/// @notice Prepare and propose a treasury transaction. Nonce, fee bounds, chain,
/// recipient, value, and calldata are fixed now; approval covers exactly these terms.
export async function proposeTreasuryIntent(
  d: TreasuryDeps,
  orgId: string,
  actor: TeamMember,
  kind: string,
  params: Record<string, unknown>,
): Promise<TreasuryIntent> {
  const team = await activeTeam(d, orgId);
  if (actor.orgId !== orgId || actor.status !== "active" || (actor.role !== "owner" && actor.role !== "manager")) {
    throw new TreasuryError(403, "forbidden", "Only team owners and managers can propose treasury transactions.");
  }
  if (kind === "update_policy") return proposePolicyChange(d, team, actor, params);
  const limits = teamLimits(d, team);
  const wallet = getAddress(team.walletAddress);
  const vault = getAddress(d.vault);
  const network = `Hedera testnet (${HEDERA_TESTNET_CHAIN_ID})`;
  let to: Address;
  let value = 0n;
  let data: Hex;
  let terms: Record<string, string>;
  let fallbackGas: bigint;
  if (kind === "buy_credits") {
    const planId = BigInt(Number.isSafeInteger(Number(params.planId ?? 0)) ? Number(params.planId ?? 0) : -1);
    if (!limits.planIds.includes(planId)) throw new TreasuryError(400, "invalid_request", "Choose a credit plan this team's wallet limits allow.");
    const plan = await d.chain.plan(planId);
    if (!plan) throw new TreasuryError(409, "plan_unavailable", "That vault plan is not available.");
    to = vault;
    value = plan.priceTinybar * WEIBAR_PER_TINYBAR;
    data = encodeFunctionData({ abi: VAULT_ABI, functionName: "subscribe", args: [planId] });
    terms = { action: "Buy compute credits", planId: String(planId), priceHbar: hbar(value), credits: String(plan.credits), vault, network };
    fallbackGas = 300_000n;
  } else if (kind === "refund") {
    const credits = await d.chain.credits(wallet);
    if (credits === 0n) throw new TreasuryError(409, "nothing_to_refund", "The team has no unused credits to refund.");
    if (await d.paymentPending(team.walletAddress)) {
      throw new TreasuryError(409, "payment_pending", "Team credits are reserved by an in-flight or unresolved request. Refund after it settles.");
    }
    to = vault;
    data = encodeFunctionData({ abi: VAULT_ABI, functionName: "refund" });
    terms = { action: "Refund unused credits", credits: String(credits), recipient: wallet, vault, network };
    fallbackGas = 200_000n;
  } else if (kind === "payout_hbar" || kind === "payout_usdc") {
    const recipient = String(params.recipient ?? "").toLowerCase();
    if (!team.payoutRecipients.includes(recipient)) throw new TreasuryError(400, "invalid_request", "Pay out only to an approved recipient.");
    if (kind === "payout_hbar") {
      to = getAddress(recipient);
      value = parseUnits(params.amount, 8, "Amount") * WEIBAR_PER_TINYBAR;
      if (value > limits.hbarPayoutCapWei) throw new TreasuryError(400, "invalid_request", `This team limits payouts to ${hbar(limits.hbarPayoutCapWei)} HBAR per transaction.`);
      data = "0x";
      terms = { action: "Pay out HBAR", asset: "HBAR", amount: hbar(value), recipient: to, network };
      fallbackGas = 50_000n;
    } else {
      const amount = parseUnits(params.amount, 6, "Amount");
      if (amount > limits.usdcPayoutCapUnits) throw new TreasuryError(400, "invalid_request", `This team limits payouts to ${formatUnits(limits.usdcPayoutCapUnits, 6)} test USDC per transaction.`);
      if ((await d.chain.tokenBalance(TEST_USDC_ADDRESS, wallet)) < amount) {
        throw new TreasuryError(402, "insufficient_funds", "The team wallet does not hold enough test USDC.");
      }
      to = getAddress(TEST_USDC_ADDRESS);
      data = encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [getAddress(recipient), amount] });
      terms = { action: "Pay out test USDC", asset: "test USDC (0.0.429274)", amount: String(Number(amount) / 1e6), units: String(amount), recipient: getAddress(recipient), network };
      fallbackGas = 1_000_000n;
    }
  } else {
    throw new TreasuryError(400, "invalid_request", "Unknown treasury action.");
  }
  const balance = await d.chain.balanceWei(wallet);
  if (balance < value) throw new TreasuryError(402, "insufficient_funds", `Deposit at least ${hbar(value - balance)} more HBAR into the team wallet first.`);
  const [nonce, gasPrice] = await Promise.all([d.chain.nonce(wallet), d.chain.gasPrice()]);
  let gas = await d.chain.estimateGas({ from: wallet, to, value, data }).then((g) => (g * 12n) / 10n).catch(() => fallbackGas);
  if (gas < 30_000n) gas = 30_000n;
  const maxFee = gas * gasPrice;
  if (balance < value + maxFee) {
    throw new TreasuryError(402, "insufficient_funds", `Deposit at least ${hbar(value + maxFee - balance)} more HBAR into the team wallet to cover the network fee.`);
  }
  const transaction: PreparedTransaction = { chain_id: HEDERA_TESTNET_CHAIN_ID, to, value: toHex(value), data, nonce, gas_limit: toHex(gas), gas_price: toHex(gasPrice), type: 0 };
  terms = { ...terms, wallet, nonce: String(nonce), maxFeeHbar: hbar(maxFee) };
  const at = nowFor(d);
  const intent: TreasuryIntent = {
    id: `trx_${randomUUID()}`,
    orgId,
    kind: kind as IntentKind,
    privyIntentId: null,
    walletAddress: team.walletAddress,
    transaction,
    policyChange: null,
    terms,
    actionHash: createHash("sha256").update(stable({ orgId, kind, transaction, terms })).digest("hex"),
    state: "proposed",
    proposedBy: actor.did,
    approvals: [],
    signedTransaction: null,
    transactionHash: null,
    result: {},
    error: null,
    createdAt: at,
    updatedAt: at,
  };
  await d.store.insert(intent);
  try {
    const remote = await d.privy.request("POST", `/intents/wallets/${team.walletId}/rpc`, { method: "eth_signTransaction", params: { transaction } });
    const proposed = await d.store.transition(intent.id, ["proposed"], { privyIntentId: remote.intent_id, state: "awaiting_approvals" });
    return proposed!;
  } catch {
    await d.store.transition(intent.id, ["proposed"], { state: "failed", error: "Privy could not create the approval request." });
    throw new TreasuryError(502, "privy_unavailable", "Privy could not create the approval request. Try again.");
  }
}

function signedBy(intent: any, type: "user" | "key", match: string): boolean {
  return (intent?.authorization_details ?? []).some((q: any) =>
    (q.members ?? []).some((m: any) => m.type === type && m.signed_at && (type === "user" ? stripDid(m.user_id) === stripDid(match) : String(m.public_key ?? "").replace(/-----[A-Z ]+-----|\s/g, "") === match)),
  );
}

function findSignedTransaction(v: unknown): Hex | null {
  if (!v || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v)) {
    if (k === "signed_transaction" && typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x)) return x as Hex;
    const nested = findSignedTransaction(x);
    if (nested) return nested;
  }
  return null;
}

async function loadIntent(d: TreasuryDeps, orgId: string, id: string): Promise<TreasuryIntent> {
  const intent = await d.store.get(id);
  if (!intent || intent.orgId !== orgId) throw new TreasuryError(404, "not_found", "Treasury transaction not found.");
  return intent;
}

/// @notice The financial approver authorizes with their Privy session; the broker
/// key signs second, only after Privy records the human signature on the same terms.
export async function approveTreasuryIntent(
  d: TreasuryDeps,
  orgId: string,
  intentId: string,
  actor: { member: TeamMember; identity: Identity; jwt: string },
): Promise<TreasuryIntent> {
  const intent = await loadIntent(d, orgId, intentId);
  const team = await activeTeam(d, orgId);
  if (stripDid(actor.identity.userId) !== stripDid(team.approverUserId) || actor.member.orgId !== orgId || actor.member.status !== "active") {
    throw new TreasuryError(403, "forbidden", "Only the team's financial approver can authorize treasury transactions.");
  }
  if (intent.state !== "awaiting_approvals" || !intent.privyIntentId) throw new TreasuryError(409, "invalid_state", `This transaction is ${intent.state.replace(/_/g, " ")}.`);
  const remote = await d.privy.request("GET", `/intents/${intent.privyIntentId}`);
  if (remote.status === "expired" || remote.status === "rejected") {
    await d.store.transition(intent.id, ["awaiting_approvals"], { state: remote.status === "expired" ? "expired" : "denied" });
    throw new TreasuryError(409, "invalid_state", `This transaction was ${remote.status} in Privy.`);
  }
  const details = remote.request_details ?? {};
  const sameTerms = intent.kind === "update_policy"
    ? remote.resource_id === team.policyId && details.method === "PATCH" && stable(details.body?.rules) === stable(intent.policyChange?.rules)
    : remote.resource_id === team.walletId && details.body?.method === "eth_signTransaction" && stable(details.body?.params?.transaction) === stable(intent.transaction);
  if (remote.status !== "pending" || !sameTerms) {
    await d.store.transition(intent.id, ["awaiting_approvals"], { state: "cancelled", error: "The Privy request no longer matches the reviewed terms." });
    throw new TreasuryError(409, "terms_changed", "The transaction terms changed. Propose it again and review the new terms.");
  }
  const payload = (timestamp: number) => ({
    version: 1,
    method: details.method,
    url: details.url,
    body: details.body,
    headers: { "privy-app-id": d.privy.appId },
    timestamp,
    intent_id: intent.privyIntentId,
  });
  if (!signedBy(remote, "user", team.approverUserId!)) {
    const timestamp = nowFor(d);
    let signature: string | undefined;
    try {
      [signature] = await d.privy.userSignatures(actor.jwt, payload(timestamp));
    } catch {
      throw new TreasuryError(401, "approval_unverified", "Privy could not verify your session for this approval. Sign in again.");
    }
    const afterUser = await d.privy.request("POST", `/intents/${intent.privyIntentId}/authorize`, { signature, timestamp });
    if (!signedBy(afterUser, "user", team.approverUserId!)) {
      throw new TreasuryError(403, "approval_rejected", "Privy did not record your approval signature.");
    }
  }
  const withUser = await d.store.transition(intent.id, ["awaiting_approvals"], {
    approvals: [...intent.approvals.filter((a) => a.method !== "privy_user"), { by: actor.identity.userId, method: "privy_user", at: nowFor(d) }],
  });
  if (!withUser) throw new TreasuryError(409, "invalid_state", "This transaction changed while approving. Refresh and retry.");
  const timestamp = nowFor(d);
  const brokerSignature = generateAuthorizationSignature({ authorizationPrivateKey: d.broker.privateKey, input: formatRequestForAuthorizationSignature(payload(timestamp) as any) });
  await d.privy.request("POST", `/intents/${intent.privyIntentId}/authorize`, { signature: brokerSignature, timestamp });
  const authorized = await d.store.transition(intent.id, ["awaiting_approvals"], {
    state: "authorized",
    approvals: [...withUser.approvals, { by: "broker", method: "broker_key", at: nowFor(d) }],
  });
  if (!authorized) throw new TreasuryError(409, "invalid_state", "This transaction changed while approving. Refresh and retry.");
  if (intent.kind === "update_policy") return finishPolicyChange(d, authorized);
  // Privy executes the signing once the quorum is satisfied and the policy allows it.
  let raw: Hex | null = null;
  let failure: string | null = null;
  for (let attempt = 0; attempt < 20 && !raw && !failure; attempt++) {
    const latest = await d.privy.request("GET", `/intents/${intent.privyIntentId}`);
    if (latest.status === "executed") raw = findSignedTransaction(latest.action_result) ?? findSignedTransaction(latest);
    if (latest.status === "executed" && !raw) failure = "Privy executed the request without returning a signed transaction.";
    if (latest.status === "failed") failure = `Privy refused to sign: ${JSON.stringify(latest.action_result ?? {}).slice(0, 200)}`;
    if (latest.status === "rejected" || latest.status === "expired") failure = `The request was ${latest.status}.`;
    if (!raw && !failure) await sleepFor(d)(1000);
  }
  if (!raw) {
    const state = failure ? "failed" : "uncertain";
    await d.store.transition(intent.id, ["authorized"], { state, error: failure ?? "Signing has not completed yet. Reconcile to check again." });
    throw new TreasuryError(failure ? 422 : 504, failure ? "signing_refused" : "signing_pending", failure ?? "Signing has not completed yet.");
  }
  return recordSignedTransaction(d, intent, raw);
}

/// @notice Policy rules compared without the ids Privy assigns.
const ruleShape = (rules: unknown) =>
  stable(
    ((Array.isArray(rules) ? rules : []) as Array<Record<string, any>>)
      .map(({ id: _id, ...rule }): Record<string, unknown> => ({ ...rule, conditions: ((rule.conditions ?? []) as Array<Record<string, unknown>>).map(({ id: _cid, ...c }) => c) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
  );

/// @notice Wait for Privy to apply an authorized policy change, confirm the policy
/// now carries exactly the reviewed rules, then record the team's new limits.
async function finishPolicyChange(d: TreasuryDeps, intent: TreasuryIntent): Promise<TreasuryIntent> {
  const change = intent.policyChange!;
  let status = "pending";
  let detail = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const latest = await d.privy.request("GET", `/intents/${intent.privyIntentId}`);
    status = String(latest.status);
    if (status === "failed") detail = JSON.stringify(latest.action_result ?? {}).slice(0, 200);
    if (status !== "pending") break;
    await sleepFor(d)(1000);
  }
  if (["failed", "rejected", "expired", "dismissed"].includes(status)) {
    await d.store.transition(intent.id, ["authorized", "uncertain"], { state: "failed", error: `Privy did not apply the change (${status}${detail ? `: ${detail}` : ""}).` });
    throw new TreasuryError(422, "policy_update_refused", `Privy did not apply the wallet limit change (${status}).`);
  }
  const policy = status === "executed" ? await d.privy.request("GET", `/policies/${change.policyId}`).catch(() => null) : null;
  if (!policy || ruleShape(policy.rules) !== ruleShape(change.rules)) {
    return (await d.store.transition(intent.id, ["authorized", "uncertain"], {
      state: "uncertain",
      error: policy ? "Privy reports policy rules that differ from the reviewed change. Reconcile to check again." : "The change is not applied yet. Reconcile to check again.",
    }))!;
  }
  await d.teams.setTreasuryLimits(intent.orgId, change.limits);
  return (await d.store.transition(intent.id, ["authorized", "uncertain"], { state: "confirmed", result: { policyUpdated: "true" }, error: null }))!;
}

async function recordSignedTransaction(d: TreasuryDeps, intent: TreasuryIntent, raw: Hex): Promise<TreasuryIntent> {
  const parsed = parseTransaction(raw);
  const expected = intent.transaction;
  const matches =
    parsed.chainId === expected.chain_id &&
    parsed.to?.toLowerCase() === expected.to.toLowerCase() &&
    (parsed.value ?? 0n) === BigInt(expected.value) &&
    (parsed.data ?? "0x").toLowerCase() === expected.data.toLowerCase() &&
    parsed.nonce === expected.nonce &&
    (parsed.gas ?? 0n) === BigInt(expected.gas_limit) &&
    (parsed.gasPrice ?? 0n) === BigInt(expected.gas_price);
  if (!matches) {
    await d.store.transition(intent.id, ["authorized", "uncertain"], { state: "failed", error: "The signed transaction does not match the approved terms. It was not broadcast." });
    throw new TreasuryError(502, "signature_mismatch", "The signed transaction does not match the approved terms. It was not broadcast.");
  }
  // Persist the exact bytes before broadcast: retries reuse this transaction identity.
  const signed = await d.store.transition(intent.id, ["authorized", "uncertain"], { state: "signed", signedTransaction: raw, transactionHash: keccak256(raw) });
  if (!signed) throw new TreasuryError(409, "invalid_state", "This transaction changed while signing. Reconcile it.");
  return broadcastSigned(d, signed);
}

async function broadcastSigned(d: TreasuryDeps, intent: TreasuryIntent): Promise<TreasuryIntent> {
  const hash = intent.transactionHash as Hex;
  const creditsBefore = intent.kind === "buy_credits" || intent.kind === "refund" ? await d.chain.credits(getAddress(intent.walletAddress)).catch(() => null) : null;
  let status = await d.chain.receipt(hash);
  if (!status) {
    await d.chain.sendRaw(intent.signedTransaction as Hex).catch(() => undefined); // may already be known; the receipt decides
    await d.store.transition(intent.id, ["signed", "uncertain"], { state: "submitted" });
    for (let attempt = 0; attempt < 30 && !status; attempt++) {
      await sleepFor(d)(2000);
      status = await d.chain.receipt(hash);
    }
  }
  if (!status) {
    return (await d.store.transition(intent.id, ["signed", "submitted", "uncertain"], { state: "uncertain", error: "No receipt yet. Reconcile to check the same transaction again." }))!;
  }
  if (status === "reverted") {
    return (await d.store.transition(intent.id, ["signed", "submitted", "uncertain"], { state: "reverted", error: "The transaction reverted onchain. Nothing was transferred." }))!;
  }
  const result: Record<string, string> = { transactionHash: hash };
  if (creditsBefore !== null) {
    const after = await d.chain.credits(getAddress(intent.walletAddress)).catch(() => null);
    if (after !== null) {
      result.creditsAfter = String(after);
      if (intent.kind === "buy_credits") result.creditsAdded = String(after - creditsBefore);
    }
  }
  return (await d.store.transition(intent.id, ["signed", "submitted", "uncertain"], { state: "confirmed", result, error: null }))!;
}

/// @notice Resolve a signed, submitted, or uncertain transaction by its stored
/// identity. Never signs a replacement; rebroadcasts the same bytes at most.
export async function reconcileTreasuryIntent(d: TreasuryDeps, orgId: string, intentId: string, actor: TeamMember): Promise<TreasuryIntent> {
  const intent = await loadIntent(d, orgId, intentId);
  if (actor.orgId !== orgId || actor.status !== "active" || actor.role === "member") throw new TreasuryError(403, "forbidden", "Only team owners and managers can reconcile treasury transactions.");
  if (intent.kind === "update_policy") return ["authorized", "uncertain"].includes(intent.state) ? finishPolicyChange(d, intent) : intent;
  if (intent.signedTransaction && ["signed", "submitted", "uncertain"].includes(intent.state)) return broadcastSigned(d, intent);
  if (intent.state === "uncertain" && intent.privyIntentId) {
    const remote = await d.privy.request("GET", `/intents/${intent.privyIntentId}`);
    const raw = remote.status === "executed" ? findSignedTransaction(remote.action_result) ?? findSignedTransaction(remote) : null;
    if (raw) return recordSignedTransaction(d, intent, raw);
  }
  return intent;
}

export async function rejectTreasuryIntent(d: TreasuryDeps, orgId: string, intentId: string, actor: TeamMember & { userId?: string }): Promise<TreasuryIntent> {
  const intent = await loadIntent(d, orgId, intentId);
  if (actor.orgId !== orgId || actor.status !== "active" || actor.role === "member") throw new TreasuryError(403, "forbidden", "Only team owners and managers can reject treasury transactions.");
  if (intent.state !== "awaiting_approvals") throw new TreasuryError(409, "invalid_state", `This transaction is ${intent.state.replace(/_/g, " ")}.`);
  if (intent.privyIntentId) await d.privy.request("POST", `/intents/${intent.privyIntentId}/reject`, {}).catch(() => undefined);
  return (await d.store.transition(intent.id, ["awaiting_approvals"], { state: "denied", error: null }))!;
}

export { OPEN_STATES };
