#!/usr/bin/env tsx
// Local end-to-end challenge test against anvil (no testnet funds).
// Deploys HostRegistry, registers a host, files a challenge via the gateway's
// fileChallenge helper, asserts challenged=true. Run: anvil first, then this.
import { execSync } from "child_process";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fileChallenge } from "../src/registry.js";

const RPC = "http://127.0.0.1:8545";
// Anvil's well-known default key #0 (public test key, zero value). Sourced from
// `cast wallet private-key` at runtime — never hand-type keys (a truncated key
// once sent this script on a 30-minute noble rabbit hole).
const KEY = execSync(
  'cast wallet private-key --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 0',
  { encoding: "utf8" },
).trim();

const FULL_ABI = parseAbi([
  "function register(string endpoint, string modelId, bytes32 modelDigest, bytes32 imageDigest, uint256 pricePerReq, uint256 pricePer1kTokens, bytes teePubkey) payable",
  "function getHost(address host) view returns ((string endpoint, string modelId, bytes32 modelDigest, bytes32 imageDigest, uint256 pricePerReq, uint256 pricePer1kTokens, bytes teePubkey, uint256 stake, bool active, uint64 registeredAt, uint64 lastHeartbeat, uint64 releaseAfter, bool challenged))",
]);

const publicClient = createPublicClient({ transport: http(RPC) });
const deployer = createWalletClient({ account: privateKeyToAccount(KEY), transport: http(RPC) });

// 1. deploy (creation bytecode + abi from forge artifacts)
const solDir = new URL("../../contracts", import.meta.url).pathname;
const run = (f: string) =>
  execSync(`forge inspect src/HostRegistry.sol:HostRegistry ${f} --json 2>/dev/null`, { cwd: solDir, encoding: "utf8" }).trim();
const artifact = { abi: JSON.parse(run("abi")), bytecode: { object: run("bytecode") } };
const deployTx = await deployer.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object as `0x${string}`,
  args: [BigInt(1e18), 86400],
});
const deployRcpt = await publicClient.waitForTransactionReceipt({ hash: deployTx });
const registry = getAddress(deployRcpt.contractAddress!);
console.log("registry:", registry);

// 2. register a host (deployer registers itself; register is permissionless)
const hostAddr = deployer.account.address;
await deployer.writeContract({
  address: registry,
  abi: FULL_ABI,
  functionName: "register",
  args: ["http://host:11434", "tiny-test", "0x" + "ab".repeat(32), "0x" + "cd".repeat(32), 1n, 0n, "0x"],
  value: BigInt(1e18),
  chain: undefined,
});
console.log("registered:", hostAddr);

// 3. file a challenge through the gateway helper (deployer key as challenger)
const tx = await fileChallenge(
  { rpcUrl: RPC, registry, operatorKey: KEY },
  hostAddr,
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
);
console.log("challenge tx:", tx);

// 4. assert challenged=true onchain
const got: any = await publicClient.readContract({
  address: registry,
  abi: FULL_ABI,
  functionName: "getHost",
  args: [hostAddr as Address],
});
const challenged = got.challenged ?? got[12];
if (!challenged) throw new Error("FAIL: challenged flag not set");
console.log("challenged=true onchain ✓");
