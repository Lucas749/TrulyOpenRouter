#!/usr/bin/env node
// One-time: create the HCS audit topic for receipt hashes. Prints topic id.
// Env (repo-root .env): DEPLOYER_ID/DEPLOYER_KEY (testnet operator).
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { AccountId, Client, PrivateKey, TopicCreateTransaction } from "@hiero-ledger/sdk";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const client = Client.forTestnet().setOperator(
  AccountId.fromString(process.env.DEPLOYER_ID),
  PrivateKey.fromStringECDSA(process.env.DEPLOYER_KEY),
);
const tx = await new TopicCreateTransaction().setTopicMemo("tor receipts audit").execute(client);
const receipt = await tx.getReceipt(client);
console.log(`topic: ${receipt.topicId}`);
await client.close();
