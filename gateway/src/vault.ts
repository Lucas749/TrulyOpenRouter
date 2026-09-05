import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DebitFn } from "./settle.js";

const VAULT_ABI = parseAbi([
  "function debit(address user, address host, uint256 amount, bytes32 receiptHash)",
]);

export interface VaultConfig {
  rpcUrl: string;
  vault: Address;
  operatorKey: Hex; // gateway role key (Key Ring in prod, env in dev)
}

/// @notice Real Vault debit for the gateway settle path. Test against anvil, run on testnet.
export function createVaultDebit(cfg: VaultConfig): DebitFn {
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
  const account = privateKeyToAccount(cfg.operatorKey);
  const wallet = createWalletClient({ account, transport: http(cfg.rpcUrl) });
  return async (user, host, amount, receiptHash) => {
    const hash = await wallet.writeContract({
      address: cfg.vault,
      abi: VAULT_ABI,
      functionName: "debit",
      args: [user as Address, host as Address, amount, receiptHash as Hex],
      chain: undefined,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };
}
