#!/usr/bin/env node
// One Vault debit via the real gateway wiring. Env: RPC_URL, VAULT, OPERATOR_KEY
// (gateway role), USER, HOST, AMOUNT (credits), RECEIPT (0x..64 hex). Prints tx hash.
import { createVaultDebit } from "../src/vault.ts";
import type { Address, Hex } from "viem";

const req = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const debit = createVaultDebit({
  rpcUrl: req("RPC_URL"),
  vault: req("VAULT") as Address,
  operatorKey: req("OPERATOR_KEY") as Hex,
});
const tx = await debit(req("USER"), req("HOST"), BigInt(req("AMOUNT")), req("RECEIPT"));
console.log(tx);
