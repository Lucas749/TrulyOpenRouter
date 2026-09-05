#!/usr/bin/env node
// Fund derived per-key budget accounts so API keys can actually spend.
// Usage: node fund-budgets.mjs --prefix tor_sk_ab12cd34 [--amount-hbar 2] [--dry-run]
//        BUDGET_MASTER + FUNDER_ID + FUNDER_KEY from repo-root .env (gitignored).
// Derivation mirrors gateway/src/budget.ts: HKDF-SHA256(master, "tor-budget-v1|prefix|counter").
// Fresh keys start empty; Hedera auto-creates hollow accounts on first HBAR receipt (HIP-583).
import { config } from "dotenv";
import { createHash } from "crypto";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  AccountBalanceQuery,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from "@hiero-ledger/sdk";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function hkdf(master, info) {
  const prk = createHash("sha256").update(Buffer.alloc(32)).update(master).digest();
  return createHash("sha256").update(prk).update(Buffer.from(info)).update(Buffer.from([1])).digest();
}

function deriveBudgetKey(masterHex, prefix) {
  const master = Buffer.from(masterHex.replace(/^0x/, ""), "hex");
  if (master.length !== 32) throw new Error("BUDGET_MASTER must be 32 bytes hex");
  for (let counter = 0; counter < 256; counter++) {
    const candidate = BigInt("0x" + hkdf(master, `tor-budget-v1|${prefix}|${counter}`).toString("hex"));
    if (candidate > 0n && candidate < SECP256K1_N) return candidate.toString(16).padStart(64, "0");
  }
  throw new Error("derivation failed");
}

function evmAddressOf(privHex) {
  const ecdh = createHash("sha256"); // placeholder replaced below
  void ecdh;
  // secp256k1 pubkey -> keccak160 via SDK key objects
  const key = PrivateKey.fromStringECDSA("0x" + privHex);
  return key.publicKey.toEvmAddress();
}

const rawArgs = process.argv.slice(2);
const args = {};
for (let i = 0; i < rawArgs.length; i++) {
  const m = rawArgs[i].match(/^--([^=]+)(=(.*))?$/);
  if (!m) continue;
  if (m[3] !== undefined) args[m[1]] = m[3];
  else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("--")) args[m[1]] = rawArgs[++i];
  else args[m[1]] = true;
}
const prefix = args.prefix;
const dryRun = args["dry-run"] !== undefined;
const amountHbar = Number(args["amount-hbar"] ?? 2);
if (!prefix) throw new Error("usage: fund-budgets.mjs --prefix <key-prefix> [--amount-hbar N] [--dry-run]");

const master = process.env.BUDGET_MASTER;
if (!master) {
  console.log("BUDGET_MASTER not set in .env — print this prefix's budget address only (no funding possible).");
  console.log("Set BUDGET_MASTER to the gateway's master to enable funding.");
  process.exit(2);
}

const privHex = deriveBudgetKey(master, prefix);
const evm = evmAddressOf(privHex);
console.log(`prefix:  ${prefix}`);
console.log(`budget:  ${evm}`);

const client = Client.forTestnet().setOperator(
  AccountId.fromString(process.env.FUNDER_ID ?? process.env.DEPLOYER_ID),
  PrivateKey.fromStringECDSA(process.env.FUNDER_KEY ?? process.env.DEPLOYER_KEY),
);
const aliasId = AccountId.fromEvmAddress(0, 0, evm);
let balance = null;
try {
  const q = await new AccountBalanceQuery().setAccountId(aliasId).execute(client);
  balance = q.hbars;
  console.log(`balance: ${balance.toString()} (account exists)`);
} catch {
  console.log("balance: 0 (hollow — first receipt creates it)");
}
if (balance && balance.toTinybars().toNumber() >= amountHbar * 1e8) {
  console.log("already funded — nothing to do");
} else if (dryRun) {
  console.log(`dry-run: would send ${amountHbar} HBAR to ${evm}`);
} else {
  const tx = await new TransferTransaction()
    .addHbarTransfer(client.operatorAccountId, Hbar.fromTinybars(-Math.round(amountHbar * 1e8)))
    .addHbarTransfer(aliasId, Hbar.fromTinybars(Math.round(amountHbar * 1e8)))
    .execute(client);
  const receipt = await tx.getReceipt(client);
  console.log(`funded ✓ ${amountHbar} HBAR — ${receipt.status.toString()}`);
}
await client.close();
console.log("FUND-DONE");
