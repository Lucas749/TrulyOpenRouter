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

/// @notice Metered price in vault credits. Onchain prices arrive in delivered value units
/// (tinybars on hashio — SPEC money rule); CREDIT_UNITS converts units→credits and MUST equal
/// the Vault's REFUND_RATE (1e5 on testnet). Override via env when networks change.
export const CREDIT_UNITS = BigInt(process.env.GATEWAY_CREDIT_UNITS ?? 100000);

/// @notice base per-req + per-1k-tokens, floored to whole credits (free-tier hosts may price 0).
export function priceForCall(
  host: HostInfo | null,
  promptTokens: number,
  completionTokens: number,
  unitsPerCredit: bigint = CREDIT_UNITS,
): bigint {
  if (!host) return 1n; // fallback upstream: flat 1 credit
  const total1k = BigInt(Math.ceil((promptTokens + completionTokens) / 1000));
  return (host.pricePerReq + total1k * host.pricePer1kTokens) / unitsPerCredit;
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
