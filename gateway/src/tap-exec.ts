import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TapKind } from "./taps.js";

// Hedera executor for approved taps (L4). Runs with the ring-held HOST_KEY —
// the key never leaves the gateway process, and execution is impossible without
// a prior device-signed Solana memo tap recorded on the tap.

const REGISTRY_ABI = parseAbi(["function heartbeat()", "function release()"]);

export interface TapExecConfig {
  rpcUrl: string;
  registry: Address;
  hostKey: Hex; // tor/host from the ring (env fallback in dev)
}

/// @notice Execute an APPROVED tap's Hedera call. Returns the tx hash.
/// heartbeat = demo-safe proof (host liveness); release = real stake release
/// (reverts unless deregistered + timelock passed — reported honestly).
export function createTapExecutor(cfg: TapExecConfig, sendTx?: (kind: TapKind) => Promise<string>) {
  if (sendTx) return sendTx;
  const account = privateKeyToAccount(cfg.hostKey);
  const wallet = createWalletClient({ account, transport: http(cfg.rpcUrl) });
  const publicClient = createPublicClient({ transport: http(cfg.rpcUrl) });
  return async (kind: TapKind): Promise<string> => {
    const functionName = kind === "heartbeat" ? "heartbeat" : "release";
    const hash = await wallet.writeContract({ address: cfg.registry, abi: REGISTRY_ABI, functionName, chain: undefined });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  };
}
