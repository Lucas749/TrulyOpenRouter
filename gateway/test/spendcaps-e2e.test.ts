import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createVaultDebit, createVaultSpendCapWriter } from "../src/vault.js";

// Full onchain loop against a local anvil + freshly deployed vault:
//   subscribe -> setSpendCap (real writer) -> debit ok -> debit over cap reverts.
// Guarded: runs only with VAULT_E2E set and an anvil on :8545. Setup:
//
//   anvil --port 8545 &
//   DEPLOYER=0xac0974bec39a17e36ba4a6b4cddf6c0f8d1efbace13600e4a2b878f8016f6225f
//   GW=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
//   VAULT=$(forge create src/SubscriptionVault.sol:SubscriptionVault \
//     --rpc-url http://127.0.0.1:8545 --private-key $DEPLOYER \
//     --constructor-args $GW 2000 1000000000000000 | grep "Deployed to" | awk '{print $3}')
//   cast send $VAULT "setPlan(uint256,uint256,uint256)" 0 10000000000000000000 10000 \
//     --rpc-url http://127.0.0.1:8545 --private-key $DEPLOYER
//   VAULT_E2E=$VAULT npx vitest run test/spendcaps-e2e.test.ts

const GW_PRIVATE = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil key[1] = gateway role
const USER_PRIVATE = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil key[2] = subscriber

describe("spend caps end-to-end on anvil", () => {
  it("writer sets cap, debit enforces it onchain", async () => {
    if (!process.env.VAULT_E2E) return; // local-only proof
    const rpcUrl = "http://127.0.0.1:8545";
    const vault = process.env.VAULT_E2E as Address;
    const user = privateKeyToAccount(USER_PRIVATE as `0x${string}`);
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const userWallet = createWalletClient({ account: user, transport: http(rpcUrl) });

    // fund: user subscribes plan 0 (10k credits for 1e19 wei at the runbook rate)
    await userWallet.writeContract({
      address: vault,
      abi: parseAbi(["function subscribe(uint256 planId) payable"]),
      functionName: "subscribe",
      args: [0n],
      value: 10000000000000000000n,
    });

    const writer = createVaultSpendCapWriter({ rpcUrl, vault, operatorKey: GW_PRIVATE as `0x${string}` });
    const debit = createVaultDebit({ rpcUrl, vault, operatorKey: GW_PRIVATE as `0x${string}` });
    const host = "0x1111111111111111111111111111111111111111";
    const h = (n: string) => `0x${n.padStart(64, "0")}` as `0x${string}`;

    await writer(user.address, 500n, 30);
    await debit(user.address, host, 400n, h("01"));
    await expect(debit(user.address, host, 101n, h("02"))).rejects.toThrow(); // SpendCapExceeded(501,500)
    await debit(user.address, host, 100n, h("03")); // exact-cap remainder works

    const cap: any = await publicClient.readContract({
      address: vault,
      abi: parseAbi(["function spendCaps(address) view returns (uint256 cap, uint64 periodStart, uint32 periodDays, uint256 spent)"]),
      functionName: "spendCaps",
      args: [user.address],
    });
    expect(cap[0]).toBe(500n);
    expect(cap[3]).toBe(500n);
  });
});
