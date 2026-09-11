// Real Key Ring runtime check on this ring member (no device needed after `ring init`).
// Decrypts gateway/secrets/*.enc through wallet-cli exactly as boot does with
// SECRETS_BACKEND=ring, and prints only names and public addresses, never secret values.
//
//   WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) \
//   npx tsx scripts/ring-runtime-check.mts
import { privateKeyToAccount } from "viem/accounts";
import { budgetAddressFor } from "../src/budget.js";
import { loadRingSecrets, PROTECTED_SECRETS, RING_MAP } from "../src/ring.js";

// Plant environment values: protected secrets must never keep them.
for (const env of Object.keys(RING_MAP)) process.env[env] = `planted-${env}`;
const { loaded, fallback, unavailable } = await loadRingSecrets();
console.log(`decrypted from ring: ${loaded.join(", ") || "none"}`);
console.log(`unavailable, operations disabled: ${unavailable.join(", ") || "none"}`);
console.log(`unprotected env fallback: ${fallback.join(", ") || "none"}`);

let failures = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
};
for (const env of PROTECTED_SECRETS) check(!process.env[env]?.startsWith("planted-"), `${env} ignores the environment value`);
check(loaded.includes("BUDGET_MASTER") && loaded.includes("X402_PAYER_KEY"), "budget master and x402 payer key decrypt on this machine");

const address = (env: string) => {
  const value = process.env[env] ?? "";
  try {
    return privateKeyToAccount((value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`).address;
  } catch {
    return "not an ECDSA key";
  }
};
if (loaded.includes("BUDGET_MASTER")) console.log(`budget master derives agent:ring-check -> ${budgetAddressFor("agent:ring-check", process.env.BUDGET_MASTER)}`);
for (const env of ["X402_PAYER_KEY", "OPERATOR_KEY", "HOST_KEY"]) if (loaded.includes(env)) console.log(`${env} public address ${address(env)}`);

console.log(failures ? `${failures} FAILURE(S)` : "RING RUNTIME CHECK PASSED");
process.exit(failures ? 1 : 0);
