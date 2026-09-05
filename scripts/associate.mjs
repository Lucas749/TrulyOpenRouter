#!/usr/bin/env node
// Associate testnet USDC (0.0.429274) on AGENT + SERVICE. Idempotent: skips if associated.
// Env (repo-root .env): AGENT_ID/AGENT_KEY, SERVICE_ID/SERVICE_KEY. Prints statuses only.
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  AccountBalanceQuery,
  AccountId,
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const USDC = TokenId.fromString("0.0.429274");
const ACCOUNTS = [
  ["AGENT", process.env.AGENT_ID, process.env.AGENT_KEY],
  ["SERVICE", process.env.SERVICE_ID, process.env.SERVICE_KEY],
];

for (const [name, id, key] of ACCOUNTS) {
  if (!id || !key) throw new Error(`missing ${name}_ID/${name}_KEY`);
  const client = Client.forTestnet().setOperator(
    AccountId.fromString(id),
    PrivateKey.fromStringECDSA(key),
  );
  const bal = await new AccountBalanceQuery().setAccountId(AccountId.fromString(id)).execute(client);
  console.log(`${name} ${id}: ${bal.hbars.toString()}`);
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(AccountId.fromString(id))
      .setTokenIds([USDC])
      .freezeWith(client);
    const submitted = await tx.execute(client);
    const receipt = await submitted.getReceipt(client);
    console.log(`  USDC associate: ${receipt.status.toString()}`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.log(`  USDC associate: ${msg.includes("ALREADY_ASSOCIATED") ? "already associated (ok)" : "FAILED: " + msg}`);
  }
  await client.close();
}
console.log("ASSOCIATE-DONE");
