import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DebitFn } from "./settle.js";

const VAULT_ABI = parseAbi([
  "function debit(address user, address host, uint256 amount, bytes32 receiptHash)",
  "function setSpendCap(address user, uint256 cap, uint32 periodDays)",
]);

export interface VaultConfig {
  rpcUrl: string;
  vault: Address;
  operatorKey: Hex; // gateway role key (Key Ring in prod, env in dev)
}

/// @notice Read-only credit check (no key needed). Used to gate wallet calls
/// BEFORE serving: 0 credits = 402 subscribe-first. Null when unreadable
/// (vault unconfigured) — never blocks on infra failure.
export async function readVaultCredits(rpcUrl: string, vault: Address, user: Address): Promise<bigint | null> {
  try {
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    return (await publicClient.readContract({
      address: vault,
      abi: parseAbi(["function credits(address) view returns (uint256)"]),
      functionName: "credits",
      args: [user],
    })) as bigint;
  } catch {
    return null;
  }
}

/// @notice Writer for onchain per-account spend caps (team allowances mirrored
/// onchain). Same operator key as debit — the gateway IS the vault's gateway
/// role. Reverts against pre-SpendCap vaults (old deployment); callers must
/// treat that as "chain sync unavailable", never as a mutation failure.
export type SpendCapWriter = (user: Address, cap: bigint, periodDays: number) => Promise<unknown>;

export function createVaultSpendCapWriter(cfg: VaultConfig): SpendCapWriter {
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
  const account = privateKeyToAccount(cfg.operatorKey);
  const wallet = createWalletClient({ account, transport: http(cfg.rpcUrl) });
  return async (user, cap, periodDays) => {
    const hash = await wallet.writeContract({
      address: cfg.vault,
      abi: VAULT_ABI,
      functionName: "setSpendCap",
      args: [user, cap, periodDays],
      chain: undefined,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };
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
