#!/usr/bin/env node
// One live paid inference: pays a host guard's x402 route from the AGENT account, prints reply.
// Env: GUARD_URL (default http://127.0.0.1:4122), MODEL (default qwen2.5:0.5b),
//      HEDERA_AGENT_ACCOUNT_ID + HEDERA_AGENT_PRIVATE_KEY (testnet). Costs ~$0.001 USDC.
import { createPaidFetch } from "../src/payer.ts";

const accountId = process.env.HEDERA_AGENT_ACCOUNT_ID;
const privateKey = process.env.HEDERA_AGENT_PRIVATE_KEY;
if (!accountId || !privateKey) throw new Error("set HEDERA_AGENT_ACCOUNT_ID + _PRIVATE_KEY");

const paid = createPaidFetch({ accountId, privateKey });
const res = await paid(`${process.env.GUARD_URL ?? "http://127.0.0.1:4122"}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: process.env.MODEL ?? "qwen2.5:0.5b",
    messages: [{ role: "user", content: "Say the word mango." }],
  }),
});
console.log("status:", res.status);
const data = await res.json();
console.log("reply:", String(data.choices?.[0]?.message?.content ?? JSON.stringify(data)).slice(0, 200));
if (!res.ok) throw new Error("paid call failed");
console.log("PAY-LIVE-OK");
