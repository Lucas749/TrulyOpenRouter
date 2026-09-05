#!/usr/bin/env tsx
// Privy intents spike: propose eth_signTransaction (sign-only, 0 value) on a team wallet,
// authorize with the server-held quorum key, poll status. Prints every step.
// Env: web/.env.local (gitignored). Args: <walletId> <quorumId>
import { readFileSync } from "fs";
import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
} from "@privy-io/node";

async function main(): Promise<void> {
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const APP_ID = env.NEXT_PUBLIC_PRIVY_APP_ID;
const SECRET = env.PRIVY_APP_SECRET;
const [walletId, quorumId] = process.argv.slice(2);
if (!APP_ID || !SECRET || !walletId || !quorumId) throw new Error("usage: intent-spike.ts <walletId> <quorumId>");

const store = JSON.parse(readFileSync(new URL("../.data/quorum-keys.json", import.meta.url), "utf8"));
const quorumKey: string | undefined = store[quorumId]?.privateKey;
if (!quorumKey) throw new Error(`no server-held key for quorum ${quorumId}`);

const H = {
  "privy-app-id": APP_ID,
  Authorization: "Basic " + Buffer.from(`${APP_ID}:${SECRET}`).toString("base64"),
  "Content-Type": "application/json",
};

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`https://api.privy.io/v1${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text: text.slice(0, 400) };
}

console.log("== propose eth_signTransaction (sign-only, value 0)");
const proposed = await call("POST", `/intents/wallets/${walletId}/rpc`, {
  method: "eth_signTransaction",
  params: { transaction: { to: "0x0000000000000000000000000000000000000000", value: "0x0", chain_id: 296 } },
});
console.log("propose:", proposed.status, JSON.stringify(proposed.json ?? proposed.text).slice(0, 300));
if (proposed.status !== 200 || !proposed.json?.intent_id) throw new Error("propose failed");
const intentId: string = proposed.json.intent_id;

console.log("== fetch intent for request_details");
const fetched = await call("GET", `/intents/${intentId}`);
const rd = fetched.json?.request_details;
console.log("status:", fetched.json?.status, "| details:", JSON.stringify(rd).slice(0, 200));
if (!rd) throw new Error("no request_details");

console.log("== sign authorization payload with quorum key");
const timestamp = Date.now();
const authorizeUrl = `https://api.privy.io/v1/intents/${intentId}/authorize`;
const variant = process.env.SIG_VARIANT ?? "action";
const proposeUrl = `https://api.privy.io/v1/wallets/${walletId}/rpc`;
const proposeBody = {
  method: "eth_signTransaction",
  params: { transaction: { to: "0x0000000000000000000000000000000000000000", value: "0x0", chain_id: 296 } },
};
const payloadInput =
  variant === "authorize"
    ? { version: 1 as const, method: "POST" as const, url: authorizeUrl, body: { timestamp }, headers: { "privy-app-id": APP_ID } }
    : variant === "original"
      ? { version: 1 as const, method: "POST" as const, url: proposeUrl, body: proposeBody, headers: { "privy-app-id": APP_ID } }
      : { version: 1 as const, method: rd.method, url: rd.url, body: rd.body, headers: { "privy-app-id": APP_ID } };
console.log("variant:", variant);
const formatted = formatRequestForAuthorizationSignature(payloadInput);
const signature = generateAuthorizationSignature({
  authorizationPrivateKey: quorumKey.replace(/^wallet-auth:/, ""),
  input: formatted,
});

console.log("== authorize");
const authed = await call("POST", `/intents/${intentId}/authorize`, {
  signature,
  timestamp,
});
console.log("authorize:", authed.status, JSON.stringify(authed.json ?? authed.text).slice(0, 300));

console.log("== poll status");
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = await call("GET", `/intents/${intentId}`);
  console.log(`t+${(i + 1) * 3}s:`, s.json?.status, JSON.stringify(s.json?.action_result ?? "").slice(0, 200));
  if (s.json?.status === "executed" || s.json?.status === "failed") break;
}
console.log("INTENT-SPIKE-DONE");
}

main().catch((e) => { console.error("FATAL:", String(e?.message ?? e).slice(0, 300)); process.exit(1); });
