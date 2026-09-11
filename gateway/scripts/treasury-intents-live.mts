// Real-world Privy intent check (opt-in; no funds move, nothing is broadcast).
//
// Uses the broker-only test wallet created by scripts/treasury-policy-live.mts. Its quorum
// needs only the broker key, so the intent path the gateway uses for team wallets runs for
// real without a human session: create an intent, authorize it with a broker signature over
// the same payload shape the gateway signs, and read the result. Covers a signing intent,
// a policy update intent (then a payout the tighter policy refuses), and restores the policy.
//
//   PRIVY_APP_ID=... PRIVY_APP_SECRET=... npx tsx scripts/treasury-intents-live.mts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatRequestForAuthorizationSignature, generateAuthorizationSignature } from "@privy-io/node";
import { createPublicClient, http, parseTransaction, toHex, type Hex } from "viem";
import { brokerKey, hederaTreasuryChain, privyAccess, treasuryPolicyRules } from "../src/treasury.js";

const RPC = process.env.RPC_URL ?? "https://testnet.hashio.io/api";
const VAULT = (process.env.VAULT_ADDRESS ?? "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576") as `0x${string}`;
const APP = process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const SECRET = process.env.PRIVY_APP_SECRET;
const STATE = process.env.LIVE_STATE ?? join(process.cwd(), "..", ".local", "live-treasury-policy.json");
if (!APP || !SECRET || !existsSync(STATE)) throw new Error("Set PRIVY_APP_ID and PRIVY_APP_SECRET, and run scripts/treasury-policy-live.mts first.");

const HBAR = 10n ** 18n;
const state = JSON.parse(readFileSync(STATE, "utf8"));
const broker = brokerKey(state.brokerPrivate);
const privy = privyAccess(APP, SECRET);
const pub = createPublicClient({ transport: http(RPC) });

let failures = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
};
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}` : JSON.stringify(v) ?? "null";
const withoutIds = (rules: any[]) => rules.map(({ id: _id, ...rule }) => ({ ...rule, conditions: (rule.conditions ?? []).map(({ id: _cid, ...c }: any) => c) }));
const shape = (rules: any[]) => stable(withoutIds(rules).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name))));
const findSigned = (v: unknown): Hex | null => {
  if (!v || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v)) {
    if (k === "signed_transaction" && typeof x === "string") return x as Hex;
    const nested = findSigned(x);
    if (nested) return nested;
  }
  return null;
};

/// The gateway's broker authorization: the request envelope plus timestamp and intent id.
async function authorizeAsBroker(intent: any) {
  const d = intent.request_details;
  const timestamp = Date.now();
  const input = { version: 1, method: d.method, url: d.url, body: d.body, headers: { "privy-app-id": APP }, timestamp, intent_id: intent.intent_id };
  const signature = generateAuthorizationSignature({ authorizationPrivateKey: broker.privateKey, input: formatRequestForAuthorizationSignature(input as any) });
  return privy.request("POST", `/intents/${intent.intent_id}/authorize`, { signature, timestamp });
}

async function finalStatus(id: string) {
  let latest: any = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    latest = await privy.request("GET", `/intents/${id}`);
    if (latest.status !== "pending" && latest.status !== "processing") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return latest;
}

const original = await privy.request("GET", `/policies/${state.policyId}`);
const originalRules = withoutIds(original.rules);
const payoutRule = originalRules.find((r: any) => r.name === "payout-hbar");
const recipient = String(payoutRule?.conditions.find((c: any) => c.field === "to")?.value?.[0] ?? "");
const plan = await hederaTreasuryChain(RPC, VAULT).plan(0n);
check(!!recipient && !!plan, `test wallet ${state.walletAddress} has an approved recipient and plan 0 exists`);
const rebuilt = treasuryPolicyRules({ vault: VAULT, plans: [{ planId: 0n, priceTinybar: plan!.priceTinybar }], recipients: [recipient], hbarPayoutCapWei: 25n * HBAR, usdcPayoutCapUnits: 5_000_000n });
check(shape(original.rules) === shape(rebuilt), "Privy stores policy rules in the exact shape the gateway builds and compares");

const [nonce, gasPrice] = await Promise.all([pub.getTransactionCount({ address: state.walletAddress, blockTag: "pending" }), pub.getGasPrice()]);
const payout = { chain_id: 296, to: recipient, value: toHex(HBAR), data: "0x", nonce, gas_limit: toHex(50_000n), gas_price: toHex(gasPrice), type: 0 };

// 1. Signing intent authorized by the broker signature.
const signing = await privy.request("POST", `/intents/wallets/${state.walletId}/rpc`, { method: "eth_signTransaction", params: { transaction: payout } });
check(signing.status === "pending" && signing.resource_id === state.walletId, `a signing intent is created pending for the wallet (${signing.status})`);
check(stable(signing.request_details?.body?.params?.transaction) === stable(payout), "Privy echoes the prepared transaction unchanged, as the gateway's terms check expects");
await authorizeAsBroker(signing);
const signed = await finalStatus(signing.intent_id);
const raw = findSigned(signed.action_result) ?? findSigned(signed);
check(signed.status === "executed" && !!raw, `the broker's authorization over the gateway payload executes it (${signed.status})`);
if (raw) {
  const tx = parseTransaction(raw);
  check(tx.to?.toLowerCase() === recipient.toLowerCase() && tx.value === HBAR && tx.nonce === nonce, "the signed bytes match the reviewed transaction (not broadcast)");
}

// 2. Policy update intent tightening the HBAR payout limit to 0.5 HBAR.
const tightened = treasuryPolicyRules({ vault: VAULT, plans: [{ planId: 0n, priceTinybar: plan!.priceTinybar }], recipients: [recipient], hbarPayoutCapWei: HBAR / 2n, usdcPayoutCapUnits: 5_000_000n });
const update = await privy.request("PATCH", `/intents/policies/${state.policyId}`, { rules: tightened });
check(update.resource_id === state.policyId && update.request_details?.method === "PATCH", `a policy intent targets the policy with PATCH (${update.intent_type ?? "?"})`);
check(stable(update.request_details?.body?.rules) === stable(tightened), "Privy echoes the proposed rules unchanged, as the gateway's terms check expects");
await authorizeAsBroker(update);
const applied = await finalStatus(update.intent_id);
const afterUpdate = await privy.request("GET", `/policies/${state.policyId}`);
check(applied.status === "executed" && shape(afterUpdate.rules) === shape(tightened), `the executed intent leaves exactly the proposed rules (${applied.status})`);

// 3. The tighter policy refuses the same 1 HBAR payout.
const refused = await privy.request("POST", `/intents/wallets/${state.walletId}/rpc`, { method: "eth_signTransaction", params: { transaction: payout } });
let refusal = "";
try {
  await authorizeAsBroker(refused);
  const result = await finalStatus(refused.intent_id);
  refusal = `${result.status} ${JSON.stringify(result.action_result ?? {}).slice(0, 120)}`;
  check(result.status === "failed" && !findSigned(result), `Privy refuses a payout above the new limit (${refusal})`);
} catch (e) {
  refusal = String((e as Error).message).slice(0, 160);
  check(/policy|denied|violat/i.test(refusal), `Privy refuses a payout above the new limit at authorization (${refusal})`);
}

// 4. Restore the original policy the same way.
const restore = await privy.request("PATCH", `/intents/policies/${state.policyId}`, { rules: originalRules });
await authorizeAsBroker(restore);
const restored = await finalStatus(restore.intent_id);
check(restored.status === "executed" && shape((await privy.request("GET", `/policies/${state.policyId}`)).rules) === shape(originalRules), `the original policy is restored (${restored.status})`);

console.log(failures ? `${failures} FAILURE(S)` : "ALL LIVE INTENT CHECKS PASSED");
process.exit(failures ? 1 : 0);
