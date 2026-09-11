// Real-world treasury policy check on Privy + Hedera testnet (opt-in, spends test HBAR).
//
// A broker-only test wallet carries the SAME rules the gateway attaches to team
// wallets, so no human session is needed. Verifies: allowed operations sign;
// wrong destination, amount, chain, function, cap, and recipient are refused by
// Privy; Privy-signed bytes broadcast and settle (subscribe -> credits, refund,
// payout back to the funder). Team wallets themselves additionally require the
// financial approver, proven by the server-key-only refusal in the gateway tests.
//
//   PRIVY_APP_ID=... PRIVY_APP_SECRET=... LIVE_FUNDER_KEY=0x<testnet key with >=12 HBAR> \
//   npx tsx scripts/treasury-policy-live.mts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { formatRequestForAuthorizationSignature, generateAuthorizationSignature } from "@privy-io/node";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, formatEther, http, parseAbi, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { brokerKey, hederaTreasuryChain, privyAccess, treasuryPolicyRules } from "../src/treasury.js";

const RPC = process.env.RPC_URL ?? "https://testnet.hashio.io/api";
const VAULT = (process.env.VAULT_ADDRESS ?? "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576") as `0x${string}`;
const APP = process.env.PRIVY_APP_ID ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const SECRET = process.env.PRIVY_APP_SECRET;
const FUNDER_KEY = process.env.LIVE_FUNDER_KEY as Hex | undefined;
const STATE = process.env.LIVE_STATE ?? join(process.cwd(), "..", ".local", "live-treasury-policy.json");
if (!APP || !SECRET || !FUNDER_KEY) throw new Error("Set PRIVY_APP_ID, PRIVY_APP_SECRET, and LIVE_FUNDER_KEY (testnet only).");

const HBAR = 10n ** 18n;
const chain = defineChain({ id: 296, name: "Hedera Testnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const funder = privateKeyToAccount(FUNDER_KEY);
const pub = createPublicClient({ chain, transport: http(RPC) });
const vaultAbi = parseAbi(["function subscribe(uint256 planId) payable", "function refund()", "function withdraw()", "function credits(address) view returns (uint256)"]);

const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
};
if (!state.brokerPrivate) {
  state.brokerPrivate = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  save();
}
const broker = brokerKey(state.brokerPrivate);
const privy = privyAccess(APP, SECRET);

if (!state.walletId) {
  const plan = await hederaTreasuryChain(RPC, VAULT).plan(0n);
  if (!plan) throw new Error("Vault plan 0 is unavailable.");
  const rules = treasuryPolicyRules({ vault: VAULT, plans: [{ planId: 0n, priceTinybar: plan.priceTinybar }], recipients: [funder.address], hbarPayoutCapWei: 25n * HBAR, usdcPayoutCapUnits: 5_000_000n });
  const quorum = await privy.request("POST", "/key_quorums", { public_keys: [broker.publicKey], authorization_threshold: 1, display_name: "tor-policy-check" });
  const policy = await privy.request("POST", "/policies", { version: "1.0", name: "tor-policy-check", chain_type: "ethereum", owner_id: quorum.id, rules });
  const wallet = await privy.request("POST", "/wallets", { chain_type: "ethereum", owner_id: quorum.id, policy_ids: [policy.id] });
  Object.assign(state, { quorumId: quorum.id, policyId: policy.id, walletId: wallet.id, walletAddress: wallet.address });
  save();
}
const wallet = state.walletAddress as `0x${string}`;
let balance = await pub.getBalance({ address: wallet });
if (balance < 11n * HBAR) {
  const hash = await createWalletClient({ account: funder, chain, transport: http(RPC) }).sendTransaction({ to: wallet, value: 12n * HBAR - balance });
  await pub.waitForTransactionReceipt({ hash });
  balance = await pub.getBalance({ address: wallet });
}
console.log(`policy test wallet ${wallet} balance ${formatEther(balance)} HBAR`);

async function sign(transaction: Record<string, unknown>) {
  const body = { method: "eth_signTransaction", params: { transaction } };
  const url = `https://api.privy.io/v1/wallets/${state.walletId}/rpc`;
  const signature = generateAuthorizationSignature({ authorizationPrivateKey: broker.privateKey, input: formatRequestForAuthorizationSignature({ version: 1, method: "POST", url, body, headers: { "privy-app-id": APP! } }) });
  const res = await fetch(url, {
    method: "POST",
    headers: { "privy-app-id": APP!, Authorization: "Basic " + Buffer.from(`${APP}:${SECRET}`).toString("base64"), "Content-Type": "application/json", "privy-authorization-signature": signature },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, raw: /"signed_transaction":"(0x[0-9a-fA-F]+)"/.exec(text)?.[1] as Hex | undefined };
}

async function broadcast(raw: Hex | undefined, label: string) {
  if (!raw) throw new Error(`${label}: Privy returned no signed transaction`);
  const hash = await pub.sendRawTransaction({ serializedTransaction: raw });
  return { hash, receipt: await pub.waitForTransactionReceipt({ hash, timeout: 90_000 }) };
}

const gasPrice = await pub.getGasPrice();
let nonce = await pub.getTransactionCount({ address: wallet, blockTag: "pending" });
const subscribe = encodeFunctionData({ abi: vaultAbi, functionName: "subscribe", args: [0n] });
const tx = (over: Record<string, unknown> = {}) => ({ chain_id: 296, to: VAULT, value: toHex(10n * HBAR), data: subscribe, nonce, gas_limit: toHex(300_000n), gas_price: toHex(gasPrice), type: 0, ...over });
const cases: Array<[string, Record<string, unknown>, boolean]> = [
  ["buy plan 0 at the exact plan price", tx(), true],
  ["send the subscription to another contract", tx({ to: "0x000000000000000000000000000000000000dEaD" }), false],
  ["pay a different amount for plan 0", tx({ value: toHex(9n * HBAR) }), false],
  ["sign for another chain", tx({ chain_id: 295 }), false],
  ["call a different vault function", tx({ value: "0x0", data: encodeFunctionData({ abi: vaultAbi, functionName: "withdraw" }) }), false],
  ["pay out above the HBAR cap", tx({ to: funder.address, value: toHex(26n * HBAR), data: "0x" }), false],
  ["pay out HBAR to an unapproved recipient", tx({ to: "0x000000000000000000000000000000000000bEEF", value: toHex(HBAR), data: "0x" }), false],
  ["pay out HBAR to the approved recipient", tx({ to: funder.address, value: toHex(HBAR), data: "0x" }), true],
];
let failures = 0;
for (const [label, t, expected] of cases) {
  const r = await sign(t);
  const allowed = r.status === 200 && !!r.raw;
  if (allowed !== expected) failures++;
  console.log(`${allowed === expected ? "PASS" : "FAIL"} ${expected ? "allow" : "deny "} ${label} -> ${r.status}${allowed ? "" : ` ${r.text.slice(0, 100)}`}`);
}

const creditsBefore = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "credits", args: [wallet] });
const signedBuy = await sign(tx());
const parsed = parseTransaction(signedBuy.raw!);
if (parsed.chainId !== 296 || parsed.nonce !== nonce || parsed.value !== 10n * HBAR || parsed.to?.toLowerCase() !== VAULT.toLowerCase()) failures++;
const buy = await broadcast(signedBuy.raw, "buy");
const creditsAfter = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "credits", args: [wallet] });
console.log(`buy ${buy.hash} -> ${buy.receipt.status}; credits ${creditsBefore} -> ${creditsAfter}`);
if (buy.receipt.status !== "success" || creditsAfter - creditsBefore !== 10_000n) failures++;

nonce += 1;
const refund = await broadcast((await sign(tx({ value: "0x0", data: encodeFunctionData({ abi: vaultAbi, functionName: "refund" }), gas_limit: toHex(200_000n) }))).raw, "refund");
const creditsRefunded = await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "credits", args: [wallet] });
console.log(`refund ${refund.hash} -> ${refund.receipt.status}; credits ${creditsRefunded}`);
if (refund.receipt.status !== "success" || creditsRefunded !== 0n) failures++;

nonce += 1;
const remaining = await pub.getBalance({ address: wallet });
const back = remaining - 50_000n * gasPrice - HBAR / 10n;
if (back > 0n) {
  const payout = await broadcast((await sign(tx({ to: funder.address, value: toHex(back < 25n * HBAR ? back : 25n * HBAR), data: "0x", gas_limit: toHex(50_000n) }))).raw, "payout");
  console.log(`payout ${payout.hash} -> ${payout.receipt.status}; wallet ${formatEther(await pub.getBalance({ address: wallet }))} HBAR`);
  if (payout.receipt.status !== "success") failures++;
}
console.log(failures ? `${failures} FAILURE(S)` : "ALL LIVE POLICY CHECKS PASSED");
process.exit(failures ? 1 : 0);
