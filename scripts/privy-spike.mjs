#!/usr/bin/env node
// Privy server-API spike: which org primitives are self-serve on our plan?
// Reads .env.local (gitignored). Creates ONE labeled test quorum + policy, reads back, stops.
// Usage: node privy-spike.mjs
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../web/.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const APP_ID = env.NEXT_PUBLIC_PRIVY_APP_ID;
const SECRET = env.PRIVY_APP_SECRET;
if (!APP_ID || !SECRET) throw new Error("missing Privy creds in web/.env.local");

const H = {
  "privy-app-id": APP_ID,
  Authorization: "Basic " + Buffer.from(`${APP_ID}:${SECRET}`).toString("base64"),
  "Content-Type": "application/json",
};

async function call(method, path, body) {
  const r = await fetch(`https://api.privy.io/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 300) };
}

console.log("== app settings (auth check)");
console.log(await call("GET", "/apps/settings").then((r) => ({ status: r.status, name: r.json?.name ?? r.text.slice(0, 80) })));

console.log("== list wallets");
console.log(await call("GET", "/wallets").then((r) => ({ status: r.status, count: r.json?.data?.length ?? r.text.slice(0, 120) })));

console.log("== create test key quorum (2-of-2 self)");
const { generateKeyPairSync } = await import("crypto");
const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const derB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const quorum = await call("POST", "/key_quorums", {
  public_keys: [derB64],
  authorization_threshold: 1,
  display_name: "spike-quorum-tor",
});
console.log("quorum:", quorum.status, JSON.stringify(quorum.json ?? quorum.text).slice(0, 200));

if (quorum.json?.id) {
  console.log("== create test policy (cap 1000 USDC-equivalent wei, owner=quorum)");
  const policy = await call("POST", "/policies", {
    version: "1.0",
    name: "spike-policy-tor",
    chain_type: "ethereum",
    owner_id: quorum.json.id,
    rules: [
      {
        name: "cap-send",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [{ field_source: "ethereum_transaction", field: "value", operator: "lte", value: "1000000000" }],
      },
    ],
  });
  console.log("policy:", policy.status, JSON.stringify(policy.json ?? policy.text).slice(0, 300));
}
console.log("SPIKE-DONE");
