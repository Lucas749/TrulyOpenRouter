import type { HostInfo } from "./registry.js";

export interface SettleInput {
  user: string;
  host: HostInfo | null;
  promptTokens: number;
  completionTokens: number;
  receiptHash: string;
}

export interface SettleResult {
  amountCredits: bigint;
  hostShare: bigint; // 90%
  settled: boolean;
  error?: string;
}

/// @notice Metered price: base per-req + per-1k-tokens, in vault credits (1 credit = $0.001).
/// Hosts price in wei onchain; the gateway maps wei→credits 1:1 at the testnet rate (SPEC §7).
export function priceForCall(host: HostInfo | null, promptTokens: number, completionTokens: number): bigint {
  if (!host) return 1n; // fallback upstream: flat 1 credit
  const total1k = BigInt(Math.ceil((promptTokens + completionTokens) / 1000));
  return host.pricePerReq + total1k * host.pricePer1kTokens;
}

export type DebitFn = (user: string, host: string, amount: bigint, receiptHash: string) => Promise<unknown>;

/// @notice Never throws: a settle failure must not eat a served completion (reconcile later).
export async function settleCall(input: SettleInput, debit: DebitFn): Promise<SettleResult> {
  const amount = priceForCall(input.host, input.promptTokens, input.completionTokens);
  try {
    await debit(input.user, input.host?.address ?? "fallback", amount, input.receiptHash);
    return { amountCredits: amount, hostShare: (amount * 9n) / 10n, settled: true };
  } catch (e) {
    return { amountCredits: amount, hostShare: (amount * 9n) / 10n, settled: false, error: String(e) };
  }
}
