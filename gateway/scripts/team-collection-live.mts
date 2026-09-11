// Real-world team collection check on Hedera testnet (opt-in; moves 100 test USDC units
// and 0.1 HBAR from the funder to the Privy test wallet, records only in a disposable DB).
//
// Verifies against real receipts: a test USDC facade transfer emits the Transfer event the
// gateway requires and the Privy wallet's balance rises; an HBAR transfer reads back with
// its destination and value; a real vault withdrawal, when one exists, decodes to its
// amount and stays pending, and a transfer from another sender cannot complete it.
//
//   set -a; . ../.env; set +a
//   TEST_DATABASE_URL=postgres://... LIVE_FUNDER_KEY=$SERVICE_KEY npx tsx scripts/team-collection-live.mts
// Requires scripts/treasury-policy-live.mts to have created the Privy test wallet.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaCollectionChain, PgTeamHosts, recordCollection, TEST_USDC_FACADE } from "../src/team-hosts.js";

const RPC = process.env.RPC_URL ?? "https://testnet.hashio.io/api";
const VAULT = (process.env.VAULT_ADDRESS ?? "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576").toLowerCase();
const FUNDER_KEY = process.env.LIVE_FUNDER_KEY;
const DATABASE = process.env.TEST_DATABASE_URL;
const STATE = join(process.cwd(), "..", ".local", "live-treasury-policy.json");
if (!FUNDER_KEY || !DATABASE || !existsSync(STATE)) {
  throw new Error("Set LIVE_FUNDER_KEY (testnet) and TEST_DATABASE_URL (disposable), and create the Privy test wallet with scripts/treasury-policy-live.mts first.");
}

const ZERO = "0x0000000000000000000000000000000000000000";
const destination = String(JSON.parse(readFileSync(STATE, "utf8")).walletAddress).toLowerCase() as `0x${string}`;
const chain = defineChain({ id: 296, name: "Hedera Testnet", nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const funder = privateKeyToAccount((FUNDER_KEY.startsWith("0x") ? FUNDER_KEY : `0x${FUNDER_KEY}`) as Hex);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: funder, chain, transport: http(RPC) });
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const pool = new Pool({ connectionString: DATABASE });
await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const store = new PgTeamHosts(pool);
const d = { store, chain: hederaCollectionChain(RPC), vault: VAULT };
const orgId = `live-collection-${Date.now()}`;

let failures = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
};
const linkHost = async (host: string) => {
  const link = await store.createLink({ orgId, teamName: "Live collection check", destination, createdBy: "did:privy:live" });
  return store.activate(link.code, host, ZERO, "0xlive");
};

// The funder stands in for a host key: collection legs are transfers the host signs.
const host = funder.address.toLowerCase();
await linkHost(host);
console.log(`destination Privy wallet ${destination}; stand-in host ${host}`);

const usdcBefore = await pub.readContract({ address: TEST_USDC_FACADE, abi: erc20, functionName: "balanceOf", args: [destination] });
const usdcTx = await wallet.writeContract({ address: TEST_USDC_FACADE, abi: erc20, functionName: "transfer", args: [destination, 100n], gas: 150_000n });
const usdcReceipt = await pub.waitForTransactionReceipt({ hash: usdcTx, timeout: 90_000 });
check(usdcReceipt.status === "success", `test USDC facade transfer ${usdcTx} succeeded`);
const usdc = await recordCollection(d, host, { asset: "usdc", transferTx: usdcTx }).catch((e) => e);
check(usdc?.state === "received" && usdc.receivedAmount === "100", `the facade Transfer event verified as received (${usdc?.state ?? usdc?.type})`);
const usdcAfter = await pub.readContract({ address: TEST_USDC_FACADE, abi: erc20, functionName: "balanceOf", args: [destination] });
check(usdcAfter - usdcBefore === 100n, `the Privy wallet's test USDC rose by 100 units (${usdcBefore} -> ${usdcAfter})`);

const hbarTx = await wallet.sendTransaction({ to: destination, value: 10n ** 17n, gas: 50_000n });
await pub.waitForTransactionReceipt({ hash: hbarTx, timeout: 90_000 });
const hbar = await d.chain.transaction(hbarTx);
check(hbar?.status === "success" && hbar.to?.toLowerCase() === destination && hbar.value === 10n ** 17n, `an HBAR transfer reads back with destination and value (${hbarTx})`);

const topic = keccak256(toBytes("Withdrawn(address,uint256)"));
const found = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/contracts/${VAULT}/results/logs?topic0=${topic}&order=desc&limit=1`).then((r) => r.json()).catch(() => ({})) as { logs?: Array<{ transaction_hash: Hex }> };
const withdrawTx = found.logs?.[0]?.transaction_hash;
if (!withdrawTx) {
  console.log("SKIP no vault earnings withdrawal exists on testnet yet; the withdrawal leg is covered by tests only");
} else {
  const withdrawal = await d.chain.transaction(withdrawTx);
  const realHost = withdrawal!.from.toLowerCase();
  await pool.query(`DELETE FROM host_collections WHERE withdraw_tx = $1`, [withdrawTx.toLowerCase()]);
  await linkHost(realHost);
  const pending = await recordCollection(d, realHost, { asset: "hbar", withdrawTx }).catch((e) => e);
  check(pending?.state === "pending" && BigInt(pending.withdrawnTinybar ?? 0) > 0n, `real withdrawal ${withdrawTx} decodes to ${pending?.withdrawnTinybar ?? pending?.type} tinybar and stays pending`);
  const refused = await recordCollection(d, realHost, { asset: "hbar", withdrawTx, transferTx: hbarTx }).catch((e) => e);
  check(refused?.type === "wrong_sender", `a transfer not sent by that host cannot complete it (${refused?.type ?? refused?.state})`);
}

await pool.query(`DELETE FROM team_host_links WHERE org_id = $1`, [orgId]);
await pool.end();
console.log(failures ? `${failures} FAILURE(S)` : "ALL LIVE COLLECTION CHECKS PASSED");
process.exit(failures ? 1 : 0);
