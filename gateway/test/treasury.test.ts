import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { formatRequestForAuthorizationSignature } from "@privy-io/node";
import { decodeFunctionData, getAddress, keccak256, parseAbi, type Hex } from "viem";
import { createApp } from "../src/index.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  approveTreasuryIntent,
  brokerKey,
  OPEN_STATES,
  PgTreasuryStore,
  PrivyRequestError,
  proposeTreasuryIntent,
  provisionTeamWallet,
  reconcileTreasuryIntent,
  rejectTreasuryIntent,
  TreasuryError,
  treasuryPolicyRules,
  type PrivyAccess,
  type TreasuryChain,
  type TreasuryDeps,
  type TreasuryIntent,
  type TreasuryStore,
} from "../src/treasury.js";
import type { Team, TeamMember } from "../src/teams.js";

const VAULT = "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576";
const TEAM_WALLET = "0x67a9beaf77675ce2cece3e2af21b9207488359d2";
const RECIPIENT = `0x${"9e".repeat(20)}`;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const BROKER = brokerKey(privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
const SIGNER = privateKeyToAccount(generatePrivateKey()); // stands in for the Privy wallet's signing key

class MemoryStore implements TreasuryStore {
  rows = new Map<string, TreasuryIntent>();
  async insert(i: TreasuryIntent) {
    if ([...this.rows.values()].some((r) => r.orgId === i.orgId && OPEN_STATES.includes(r.state))) throw new TreasuryError(409, "treasury_busy", "busy");
    this.rows.set(i.id, structuredClone(i));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async list(orgId: string) {
    return [...this.rows.values()].filter((r) => r.orgId === orgId).map((r) => structuredClone(r));
  }
  async transition(id: string, from: TreasuryIntent["state"][], patch: Partial<TreasuryIntent>) {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.state)) return null;
    Object.assign(r, patch, { updatedAt: Date.now() });
    return structuredClone(r);
  }
}

const pem = (b64: string) => `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;

function fakePrivy(opts: { threshold?: number } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const intents = new Map<string, any>();
  const policies = new Map<string, any[]>();
  const control = { userAccepts: true, policyFails: false, tamperSigned: false, storedRulesDiffer: false };
  const quorum = () => [{ threshold: 2, members: [{ type: "user", user_id: "approver", signed_at: null }, { type: "key", public_key: pem(BROKER.publicKey), signed_at: null }] }];
  const privy: PrivyAccess = {
    appId: "app-test",
    async request(method, path, body) {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/key_quorums") return { id: "quorum-1" };
      if (method === "POST" && path === "/organizations") return { id: "org-1" };
      if (method === "POST" && path === "/policies") {
        policies.set("policy-1", structuredClone((body as any).rules));
        return { id: "policy-1", rules: (body as any).rules };
      }
      const policy = path.match(/^\/policies\/([^/]+)$/);
      if (method === "GET" && policy) {
        // Privy returns stored rules with ids it assigns.
        return { id: policy[1], rules: (policies.get(policy[1]) ?? []).map((r, i) => ({ id: `rule-${i}`, ...r, conditions: r.conditions.map((c: any, j: number) => ({ id: `cond-${i}-${j}`, ...c })) })) };
      }
      const policyIntent = path.match(/^\/intents\/policies\/([^/]+)$/);
      if (method === "PATCH" && policyIntent) {
        const id = `intent-${intents.size + 1}`;
        intents.set(id, {
          intent_id: id,
          intent_type: "POLICY",
          status: "pending",
          resource_id: policyIntent[1],
          request_details: { method: "PATCH", url: `https://api.privy.io/v1/policies/${policyIntent[1]}`, body: structuredClone(body) },
          authorization_details: quorum(),
        });
        return structuredClone(intents.get(id));
      }
      if (method === "POST" && path === "/wallets") return { id: "wallet-1", address: TEAM_WALLET };
      if (method === "GET" && path === "/wallets/wallet-1") return { id: "wallet-1", owner_id: "quorum-1", policy_ids: ["policy-1"], additional_signers: [] };
      if (method === "GET" && path === "/key_quorums/quorum-1") {
        return { id: "quorum-1", authorization_threshold: opts.threshold ?? 2, user_ids: ["did:privy:approver"], authorization_keys: [{ public_key: BROKER.publicKey }], key_quorum_ids: [] };
      }
      const rpc = path.match(/^\/intents\/wallets\/([^/]+)\/rpc$/);
      if (method === "POST" && rpc) {
        const id = `intent-${intents.size + 1}`;
        intents.set(id, {
          intent_id: id,
          status: "pending",
          resource_id: rpc[1],
          request_details: { method: "POST", url: `https://api.privy.io/v1/wallets/${rpc[1]}/rpc`, body: structuredClone(body) },
          authorization_details: quorum(),
        });
        return structuredClone(intents.get(id));
      }
      const get = path.match(/^\/intents\/([^/]+)$/);
      if (method === "GET" && get) return structuredClone(intents.get(get[1]));
      const reject = path.match(/^\/intents\/([^/]+)\/reject$/);
      if (method === "POST" && reject) {
        intents.get(reject[1]).status = "rejected";
        return structuredClone(intents.get(reject[1]));
      }
      const authorize = path.match(/^\/intents\/([^/]+)\/authorize$/);
      if (method === "POST" && authorize) {
        const intent = intents.get(authorize[1]);
        const { signature, timestamp } = body as { signature: string; timestamp: number };
        const [user, key] = intent.authorization_details[0].members;
        if (signature.startsWith("user:")) {
          if (control.userAccepts) user.signed_at = timestamp;
        } else {
          const bytes = formatRequestForAuthorizationSignature({ version: 1, method: intent.request_details.method, url: intent.request_details.url, body: intent.request_details.body, headers: { "privy-app-id": "app-test" }, timestamp, intent_id: authorize[1] } as any);
          const ok = verifySignature("sha256", Buffer.from(bytes), { key: Buffer.from(BROKER.publicKey, "base64"), format: "der", type: "spki" }, Buffer.from(signature, "base64"));
          if (!ok) throw new PrivyRequestError(400, "No valid authorization key found for signature");
          key.signed_at = timestamp;
        }
        if (user.signed_at && key.signed_at) {
          if (control.policyFails) {
            intent.status = "failed";
            intent.action_result = { status_code: 400, response_body: { error: "policy_violation" } };
          } else if (intent.request_details.method === "PATCH") {
            const rules = structuredClone(intent.request_details.body.rules);
            if (control.storedRulesDiffer) rules.pop();
            policies.set(intent.resource_id, rules);
            intent.status = "executed";
            intent.action_result = { status_code: 200, executed_at: timestamp };
          } else {
            const tx = intent.request_details.body.params.transaction;
            const signed = await SIGNER.signTransaction({
              chainId: tx.chain_id, to: tx.to, value: BigInt(tx.value) + (control.tamperSigned ? 1n : 0n), data: tx.data, nonce: tx.nonce,
              gas: BigInt(tx.gas_limit), gasPrice: BigInt(tx.gas_price), type: "legacy",
            });
            intent.status = "executed";
            intent.action_result = { status_code: 200, executed_at: timestamp, response_body: { method: "eth_signTransaction", data: { signed_transaction: signed, encoding: "rlp" } } };
          }
        }
        return structuredClone(intent);
      }
      throw new Error(`unexpected Privy call ${method} ${path}`);
    },
    userSignatures: vi.fn(async (jwt: string, payload: Record<string, unknown>) => {
      if (jwt !== "approver-jwt") throw new Error("JWT exchange failed");
      return [`user:${payload.timestamp}`];
    }),
  };
  return { privy, calls, intents, control, policies };
}

function fakeChain() {
  const state = { credits: 0n, balance: 50n * 10n ** 18n, receipts: new Map<string, "success" | "reverted">(), autoReceipt: true };
  const sent: Hex[] = [];
  const chain: TreasuryChain = {
    plan: async (id) => (id === 0n ? { priceTinybar: 1_000_000_000n, credits: 10_000n } : null),
    credits: async () => state.credits,
    balanceWei: async () => state.balance,
    tokenBalance: async () => 10_000_000n,
    nonce: async () => 7,
    gasPrice: async () => 710_000_000_000n,
    estimateGas: async () => 100_000n,
    sendRaw: async (raw) => {
      sent.push(raw);
      if (state.autoReceipt && !state.receipts.has(keccak256(raw))) {
        state.receipts.set(keccak256(raw), "success");
        state.credits += 10_000n;
      }
      return keccak256(raw);
    },
    receipt: async (hash) => state.receipts.get(hash) ?? null,
  };
  return { chain, state, sent };
}

const TEAM: Team = {
  orgId: "org-1", name: "Acme", walletId: "wallet-1", walletAddress: TEAM_WALLET, quorumId: "quorum-1", policyId: "policy-1",
  approverUserId: "did:privy:approver", payoutRecipients: [RECIPIENT], state: "active", defaultAllowanceCredits: null, membershipRevision: 1,
};
const member = (did: string, role: TeamMember["role"]): TeamMember => ({ orgId: "org-1", did, wallet: null, email: null, role, status: "active", allowanceCredits: null });
const OWNER = member("did:privy:approver", "owner");
const MANAGER = member("did:privy:manager", "manager");

function deps(over: Partial<TreasuryDeps> = {}) {
  const p = fakePrivy();
  const c = fakeChain();
  const store = new MemoryStore();
  const teams = {
    team: vi.fn(async (id: string): Promise<Team | null> => (id === "org-1" ? TEAM : null)),
    setTeamWallet: vi.fn(async (_id: string, w: any) => ({ ...TEAM, ...w })),
    setTreasuryLimits: vi.fn(async (_id: string, l: any) => ({ ...TEAM, payoutRecipients: l.payoutRecipients, limits: { planIds: l.planIds, hbarPayoutCapWei: l.hbarPayoutCapWei, usdcPayoutCapUnits: l.usdcPayoutCapUnits } })),
  };
  const d: TreasuryDeps = {
    privy: p.privy, broker: BROKER, chain: c.chain, vault: VAULT, planIds: [0n], hbarPayoutCapWei: 25n * 10n ** 18n, usdcPayoutCapUnits: 5_000_000n,
    teams, store, paymentPending: async () => false, sleep: async () => {}, ...over,
  };
  return { d, p, c, store, teams };
}

const approver = { member: OWNER, identity: { userId: "did:privy:approver", wallets: [] }, jwt: "approver-jwt" };

describe("team treasury policy", () => {
  it("allows only reviewed operations with exact plan terms and approved recipients", () => {
    const rules = treasuryPolicyRules({ vault: VAULT, plans: [{ planId: 0n, priceTinybar: 1_000_000_000n }], recipients: [RECIPIENT], hbarPayoutCapWei: 25n * 10n ** 18n, usdcPayoutCapUnits: 5_000_000n });
    expect(rules.map((r) => r.name)).toEqual(["buy-credits-plan-0", "refund-credits", "payout-hbar", "payout-test-usdc"]);
    expect(rules.every((r) => r.method === "eth_signTransaction" && r.action === "ALLOW")).toBe(true);
    const buy = rules[0].conditions as any[];
    expect(buy).toEqual(expect.arrayContaining([
      { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "296" },
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: "0xD75C46C0e82115ab4D24326DBbbbFFe4e7d0c576" },
      { field_source: "ethereum_transaction", field: "value", operator: "eq", value: "10000000000000000000" },
      expect.objectContaining({ field_source: "ethereum_calldata", field: "subscribe.planId", operator: "eq", value: "0" }),
    ]));
    expect((rules[1].conditions as any[]).find((c) => c.field === "function_name")).toMatchObject({ value: "refund" });
    expect((rules[2].conditions as any[]).find((c) => c.field === "to")).toMatchObject({ operator: "in", value: [getAddress(RECIPIENT)] });
    expect((rules[3].conditions as any[]).find((c) => c.field === "transfer.amount")).toMatchObject({ operator: "lte", value: "5000000" });
    expect(treasuryPolicyRules({ vault: VAULT, plans: [], recipients: [], hbarPayoutCapWei: 1n, usdcPayoutCapUnits: 1n }).map((r) => r.name)).toEqual(["refund-credits"]);
  });
});

describe("team wallet provisioning", () => {
  it("activates only after Privy confirms the approver and broker 2-of-2 quorum", async () => {
    const { d, p, teams } = deps();
    const team = await provisionTeamWallet(d, { name: "Acme", approverUserId: "did:privy:approver", recipients: [RECIPIENT] });
    const posts = p.calls.filter((c) => c.method === "POST").map((c) => c.path);
    expect(posts).toEqual(["/key_quorums", "/organizations", "/policies", "/wallets"]);
    expect(p.calls[0].body).toMatchObject({ user_ids: ["did:privy:approver"], public_keys: [BROKER.publicKey], authorization_threshold: 2 });
    expect(p.calls[1].body).toMatchObject({ default_key_quorum_id: "quorum-1" });
    expect(p.calls[2].body).toMatchObject({ owner_id: "quorum-1", chain_type: "ethereum" });
    expect(p.calls[3].body).toEqual({ chain_type: "ethereum", entity: { id: "org-1", type: "organization" }, policy_ids: ["policy-1"] });
    expect(teams.setTeamWallet).toHaveBeenCalledWith("org-1", expect.objectContaining({ walletId: "wallet-1", approverUserId: "did:privy:approver", payoutRecipients: [RECIPIENT] }));
    expect(team.state).toBe("active");
  });

  it("refuses to activate a wallet that a server key alone could control", async () => {
    const { d, teams } = deps();
    d.privy = fakePrivy({ threshold: 1 }).privy;
    await expect(provisionTeamWallet(d, { name: "Acme", approverUserId: "did:privy:approver", recipients: [RECIPIENT] })).rejects.toMatchObject({ status: 502, type: "wallet_unverified" });
    expect(teams.setTeamWallet).not.toHaveBeenCalled();
    await expect(provisionTeamWallet(d, { name: "Acme", approverUserId: "not-a-login", recipients: [RECIPIENT] })).rejects.toMatchObject({ status: 400 });
  });
});

describe("team treasury transactions", () => {
  it("prepares exact subscription terms and requires funds and a permitted proposer", async () => {
    const { d, p, c } = deps();
    await expect(proposeTreasuryIntent(d, "org-1", member("did:privy:m", "member"), "buy_credits", { planId: 0 })).rejects.toMatchObject({ status: 403 });
    c.state.balance = 5n * 10n ** 18n;
    await expect(proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 0 })).rejects.toMatchObject({ status: 402, type: "insufficient_funds" });
    expect(p.calls.some((x) => x.path.startsWith("/intents"))).toBe(false);
    c.state.balance = 50n * 10n ** 18n;
    const intent = await proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 0 });
    expect(intent.state).toBe("awaiting_approvals");
    expect(intent.transaction).toMatchObject({ chain_id: 296, to: "0xD75C46C0e82115ab4D24326DBbbbFFe4e7d0c576", value: "0x8ac7230489e80000", nonce: 7, gas_limit: "0x1d4c0", gas_price: "0xa54f4c3c00", type: 0 });
    expect(decodeFunctionData({ abi: parseAbi(["function subscribe(uint256 planId) payable"]), data: intent.transaction.data })).toMatchObject({ functionName: "subscribe", args: [0n] });
    expect(intent.terms).toMatchObject({ credits: "10000", priceHbar: "10", maxFeeHbar: "0.0852", nonce: "7" });
    await expect(proposeTreasuryIntent(d, "org-1", MANAGER, "buy_credits", { planId: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(proposeTreasuryIntent(d, "org-1", OWNER, "payout_hbar", { recipient: `0x${"12".repeat(20)}`, amount: "1" })).rejects.toMatchObject({ status: 400 });
  });

  it("needs the financial approver's own Privy authorization before the broker signs, then confirms stored bytes", async () => {
    const { d, p, c, store } = deps();
    const intent = await proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 0 });
    await expect(approveTreasuryIntent(d, "org-1", intent.id, { member: MANAGER, identity: { userId: "did:privy:manager", wallets: [] }, jwt: "manager-jwt" })).rejects.toMatchObject({ status: 403 });
    await expect(approveTreasuryIntent(d, "org-1", intent.id, { ...approver, jwt: "stolen" })).rejects.toMatchObject({ status: 401 });
    expect(p.calls.filter((x) => x.path.endsWith("/authorize"))).toHaveLength(0);

    const originalSend = c.chain.sendRaw;
    c.chain.sendRaw = async (raw) => {
      const stored = await store.get(intent.id);
      expect(stored?.signedTransaction).toBe(raw); // persisted before broadcast
      return originalSend(raw);
    };
    const done = await approveTreasuryIntent(d, "org-1", intent.id, approver);
    const authorizations = p.calls.filter((x) => x.path.endsWith("/authorize"));
    expect(authorizations).toHaveLength(2);
    expect(authorizations[0].body.signature).toMatch(/^user:/);
    expect(done).toMatchObject({ state: "confirmed", result: { creditsAdded: "10000", creditsAfter: "10000" } });
    expect(done.approvals.map((a) => a.method)).toEqual(["privy_user", "broker_key"]);
    expect(done.transactionHash).toBe(keccak256(done.signedTransaction as Hex));
    expect(c.sent).toEqual([done.signedTransaction]);
  });

  it("stops before the broker signs when Privy does not record the human approval", async () => {
    const { d, p } = deps();
    p.control.userAccepts = false;
    const intent = await proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 0 });
    await expect(approveTreasuryIntent(d, "org-1", intent.id, approver)).rejects.toMatchObject({ status: 403, type: "approval_rejected" });
    const signatures = p.calls.filter((x) => x.path.endsWith("/authorize")).map((x) => x.body.signature);
    expect(signatures.every((s: string) => s.startsWith("user:"))).toBe(true);
    expect(p.intents.get(intent.privyIntentId!).status).toBe("pending");
  });

  it("cancels when the Privy request no longer matches the reviewed terms", async () => {
    const { d, p, store } = deps();
    const intent = await proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 0 });
    p.intents.get(intent.privyIntentId!).request_details.body.params.transaction.to = RECIPIENT;
    await expect(approveTreasuryIntent(d, "org-1", intent.id, approver)).rejects.toMatchObject({ status: 409, type: "terms_changed" });
    expect((await store.get(intent.id))?.state).toBe("cancelled");
    expect(p.calls.filter((x) => x.path.endsWith("/authorize"))).toHaveLength(0);
  });

  it("records a Privy policy refusal and signed bytes that differ from the terms without broadcasting", async () => {
    const refused = deps();
    refused.p.control.policyFails = true;
    const a = await proposeTreasuryIntent(refused.d, "org-1", OWNER, "buy_credits", { planId: 0 });
    await expect(approveTreasuryIntent(refused.d, "org-1", a.id, approver)).rejects.toMatchObject({ status: 422, type: "signing_refused" });
    expect((await refused.store.get(a.id))?.state).toBe("failed");
    expect(refused.c.sent).toHaveLength(0);

    const tampered = deps();
    tampered.p.control.tamperSigned = true;
    const b = await proposeTreasuryIntent(tampered.d, "org-1", OWNER, "buy_credits", { planId: 0 });
    await expect(approveTreasuryIntent(tampered.d, "org-1", b.id, approver)).rejects.toMatchObject({ status: 502, type: "signature_mismatch" });
    expect((await tampered.store.get(b.id))?.state).toBe("failed");
    expect(tampered.c.sent).toHaveLength(0);
  });

  it("keeps an unconfirmed broadcast uncertain and reconciles the same transaction without re-signing", async () => {
    const { d, p, c } = deps();
    c.state.autoReceipt = false;
    const intent = await proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 0 });
    const pending = await approveTreasuryIntent(d, "org-1", intent.id, approver);
    expect(pending.state).toBe("uncertain");
    const authorizeCalls = p.calls.filter((x) => x.path.endsWith("/authorize")).length;
    await expect(proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 0 })).rejects.toMatchObject({ status: 409 });
    c.state.receipts.set(pending.transactionHash!, "success");
    c.state.credits = 10_000n;
    const settled = await reconcileTreasuryIntent(d, "org-1", intent.id, OWNER);
    expect(settled.state).toBe("confirmed");
    expect(new Set(c.sent)).toEqual(new Set([pending.signedTransaction]));
    expect(p.calls.filter((x) => x.path.endsWith("/authorize")).length).toBe(authorizeCalls);
  });

  it("lets owners reject a pending transaction and blocks refunds while payments are unresolved", async () => {
    const { d, p, c } = deps();
    const intent = await proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 0 });
    expect((await rejectTreasuryIntent(d, "org-1", intent.id, MANAGER)).state).toBe("denied");
    expect(p.intents.get(intent.privyIntentId!).status).toBe("rejected");
    c.state.credits = 500n;
    d.paymentPending = async (payer) => payer === TEAM_WALLET;
    await expect(proposeTreasuryIntent(d, "org-1", OWNER, "refund", {})).rejects.toMatchObject({ status: 409, type: "payment_pending" });
  });
});

describe("team wallet limits", () => {
  const OTHER = `0x${"ab".repeat(20)}`;
  const change = { planIds: [0], hbarPayoutCap: "40", usdcPayoutCap: "12.5", recipients: [RECIPIENT, OTHER] };

  it("lets owners propose limits that change Privy only after the financial approver authorizes the exact rules", async () => {
    const { d, p, teams } = deps();
    await expect(proposeTreasuryIntent(d, "org-1", MANAGER, "update_policy", change)).rejects.toMatchObject({ status: 403 });
    const intent = await proposeTreasuryIntent(d, "org-1", OWNER, "update_policy", change);
    expect(intent).toMatchObject({ kind: "update_policy", state: "awaiting_approvals", terms: { action: "Change wallet limits", plans: "0", hbarPayoutCap: "40", usdcPayoutCap: "12.5" } });
    const expected = treasuryPolicyRules({ vault: VAULT, plans: [{ planId: 0n, priceTinybar: 1_000_000_000n }], recipients: [RECIPIENT, OTHER], hbarPayoutCapWei: 40n * 10n ** 18n, usdcPayoutCapUnits: 12_500_000n });
    expect(p.calls.find((c) => c.method === "PATCH")).toMatchObject({ path: "/intents/policies/policy-1", body: { rules: expected } });

    await expect(approveTreasuryIntent(d, "org-1", intent.id, { member: MANAGER, identity: { userId: "did:privy:manager", wallets: [] }, jwt: "manager-jwt" })).rejects.toMatchObject({ status: 403 });
    const done = await approveTreasuryIntent(d, "org-1", intent.id, approver);
    expect(done).toMatchObject({ state: "confirmed", result: { policyUpdated: "true" } });
    expect(done.approvals.map((a) => a.method)).toEqual(["privy_user", "broker_key"]);
    expect(p.policies.get("policy-1")).toEqual(expected);
    expect(teams.setTreasuryLimits).toHaveBeenCalledWith("org-1", { planIds: ["0"], hbarPayoutCapWei: String(40n * 10n ** 18n), usdcPayoutCapUnits: "12500000", payoutRecipients: [RECIPIENT, OTHER] });
  });

  it("enforces the team's own limits before preparing transactions", async () => {
    const { d, teams } = deps({ planIds: [0n, 1n] });
    teams.team.mockImplementation(async () => ({ ...TEAM, limits: { planIds: ["0"], hbarPayoutCapWei: String(2n * 10n ** 18n), usdcPayoutCapUnits: "1000000" } }));
    await expect(proposeTreasuryIntent(d, "org-1", OWNER, "payout_hbar", { recipient: RECIPIENT, amount: "3" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("2 HBAR") });
    await expect(proposeTreasuryIntent(d, "org-1", OWNER, "payout_usdc", { recipient: RECIPIENT, amount: "1.5" })).rejects.toMatchObject({ status: 400 });
    await expect(proposeTreasuryIntent(d, "org-1", OWNER, "buy_credits", { planId: 1 })).rejects.toMatchObject({ status: 400 });
    expect((await proposeTreasuryIntent(d, "org-1", OWNER, "payout_hbar", { recipient: RECIPIENT, amount: "2" })).state).toBe("awaiting_approvals");
  });

  it("refuses limit changes outside the offered plans or without valid caps and recipients", async () => {
    const { d, p } = deps();
    for (const bad of [
      { ...change, planIds: [] },
      { ...change, planIds: [7] },
      { ...change, hbarPayoutCap: "0" },
      { ...change, usdcPayoutCap: "1.1234567" },
      { ...change, recipients: [] },
      { ...change, recipients: ["not-an-address"] },
      { ...change, recipients: [VAULT] },
      { ...change, recipients: ["0x0000000000000000000000000000000000068cda"] },
      { ...change, recipients: [TEAM_WALLET] },
    ]) {
      await expect(proposeTreasuryIntent(d, "org-1", OWNER, "update_policy", bad)).rejects.toMatchObject({ status: 400 });
    }
    expect(p.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("cancels changed terms, and records limits only once Privy stores exactly the reviewed rules", async () => {
    const tampered = deps();
    const a = await proposeTreasuryIntent(tampered.d, "org-1", OWNER, "update_policy", change);
    tampered.p.intents.get(a.privyIntentId!).request_details.body.rules[0].conditions[2].value = "1";
    await expect(approveTreasuryIntent(tampered.d, "org-1", a.id, approver)).rejects.toMatchObject({ status: 409, type: "terms_changed" });
    expect(tampered.p.calls.filter((c) => c.path.endsWith("/authorize"))).toHaveLength(0);

    const differs = deps();
    differs.p.control.storedRulesDiffer = true;
    const b = await proposeTreasuryIntent(differs.d, "org-1", OWNER, "update_policy", change);
    expect((await approveTreasuryIntent(differs.d, "org-1", b.id, approver)).state).toBe("uncertain");
    expect(differs.teams.setTreasuryLimits).not.toHaveBeenCalled();
    differs.p.policies.set("policy-1", structuredClone(b.policyChange!.rules));
    expect((await reconcileTreasuryIntent(differs.d, "org-1", b.id, OWNER)).state).toBe("confirmed");
    expect(differs.teams.setTreasuryLimits).toHaveBeenCalledTimes(1);

    const refused = deps();
    refused.p.control.policyFails = true;
    const c = await proposeTreasuryIntent(refused.d, "org-1", OWNER, "update_policy", change);
    await expect(approveTreasuryIntent(refused.d, "org-1", c.id, approver)).rejects.toMatchObject({ status: 422, type: "policy_update_refused" });
    expect(refused.teams.setTreasuryLimits).not.toHaveBeenCalled();
  });
});

describe("team treasury routes", () => {
  it("serve only verified members of the team and derive the approver from the session", async () => {
    const { d } = deps();
    const sessions: Record<string, { userId: string; wallets: string[] }> = {
      "approver-jwt": { userId: "did:privy:approver", wallets: [] },
      "manager-jwt": { userId: "did:privy:manager", wallets: [] },
      "outsider-jwt": { userId: "did:privy:outsider", wallets: [] },
    };
    const members: Record<string, TeamMember> = { "did:privy:approver": OWNER, "did:privy:manager": MANAGER };
    const app = createApp({
      requireSubscription: false,
      verifySession: async (jwt) => {
        if (!sessions[jwt]) throw Object.assign(new Error("invalid"), { status: 401 });
        return sessions[jwt] as any;
      },
      teams: { memberFor: async (orgId: string, identity: { userId: string }) => (orgId === "org-1" ? members[identity.userId] ?? null : null), team: async (id: string) => (id === "org-1" ? TEAM : null) } as any,
      treasury: d,
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (path: string, jwt?: string, body?: unknown) =>
      fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      expect((await call("/api/team/orgs/org-1/treasury")).status).toBe(401);
      expect((await call("/api/team/orgs/org-1/treasury", "tor_sk_agentkey")).status).toBe(401);
      expect((await call("/api/team/orgs/org-1/treasury", "outsider-jwt")).status).toBe(404);
      const view: any = await (await call("/api/team/orgs/org-1/treasury", "manager-jwt")).json();
      expect(view).toMatchObject({ team: { walletAddress: TEAM_WALLET, approverUserId: "did:privy:approver" }, balances: { credits: "0", hbarWei: "50000000000000000000" }, plans: [{ planId: "0", credits: "10000", allowed: true }], limits: { planIds: ["0"], hbarPayoutCap: "25", usdcPayoutCap: "5", recipients: [RECIPIENT] }, me: { role: "manager", financialApprover: false } });
      const proposed: any = await (await call("/api/team/orgs/org-1/intents", "manager-jwt", { kind: "buy_credits", planId: 0 })).json();
      expect(proposed.intent.state).toBe("awaiting_approvals");
      const byManager = await call(`/api/team/orgs/org-1/intents/${proposed.intent.id}/approve`, "manager-jwt", {});
      expect(byManager.status).toBe(403);
      const confirmed: any = await (await call(`/api/team/orgs/org-1/intents/${proposed.intent.id}/approve`, "approver-jwt", {})).json();
      expect(confirmed.intent.state).toBe("confirmed");
      expect((await call(`/api/team/orgs/org-1/intents/${proposed.intent.id}`, "outsider-jwt")).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("durable treasury intents", () => {
  const pool = new Pool({ connectionString: database });
  const store = new PgTreasuryStore(pool);
  const intent = (id: string, state: TreasuryIntent["state"]): TreasuryIntent => ({
    id, orgId: "test-treasury", kind: "buy_credits", privyIntentId: null, walletAddress: TEAM_WALLET,
    transaction: { chain_id: 296, to: VAULT, value: "0x1", data: "0x", nonce: 1, gas_limit: "0x1", gas_price: "0x1", type: 0 }, policyChange: null,
    terms: { action: "Buy compute credits" }, actionHash: "hash", state, proposedBy: "did:privy:approver", approvals: [],
    signedTransaction: null, transactionHash: null, result: {}, error: null, createdAt: Date.now(), updatedAt: Date.now(),
  });
  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM team_finance WHERE org_id = 'test-treasury'`);
    await pool.query(`INSERT INTO team_finance (org_id, created_at, updated_at) VALUES ('test-treasury', 1, 1)`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("allows one unfinished transaction per team and applies state changes conditionally", async () => {
    await store.insert(intent("trx-1", "awaiting_approvals"));
    await expect(store.insert(intent("trx-2", "proposed"))).rejects.toMatchObject({ status: 409 });
    expect(await store.transition("trx-1", ["signed"], { state: "confirmed" })).toBeNull();
    const signed = await store.transition("trx-1", ["awaiting_approvals"], { state: "signed", signedTransaction: "0xabc", approvals: [{ by: "u", method: "privy_user", at: 1 }] });
    expect(signed).toMatchObject({ state: "signed", signedTransaction: "0xabc", approvals: [{ by: "u", method: "privy_user", at: 1 }] });
    await store.transition("trx-1", ["signed"], { state: "confirmed", result: { creditsAdded: "10000" } });
    await store.insert(intent("trx-3", "proposed"));
    expect((await store.list("test-treasury")).map((i) => i.id)).toEqual(expect.arrayContaining(["trx-1", "trx-3"]));
    expect((await store.get("trx-1"))?.result).toEqual({ creditsAdded: "10000" });

    await store.transition("trx-3", ["proposed"], { state: "cancelled" });
    const policyChange = { policyId: "policy-1", rules: [{ name: "refund-credits" }], limits: { planIds: ["0"], hbarPayoutCapWei: "1", usdcPayoutCapUnits: "1", payoutRecipients: [RECIPIENT] } };
    await store.insert({ ...intent("trx-4", "awaiting_approvals"), kind: "update_policy", transaction: {} as any, policyChange });
    expect((await store.get("trx-4"))?.policyChange).toEqual(policyChange);
  });
});
