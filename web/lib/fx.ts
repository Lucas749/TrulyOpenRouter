// Indicative USD rates (Sep 2026) for human-termed caps. Static marketing-grade
// numbers, NOT live quotes: caps enforce the converted native units at creation.
// Refresh when obviously stale. CLIENT-SAFE.

export const FX_DATE = "2026-09-08";
export const USD_PER_HBAR = 0.08;
export const USD_PER_ETH = 2450;
export const USD_PER_BTC = 79000;

/** $X -> HBAR wei (1 HBAR = 1e18 wei on the Hedera EVM relay). */
export function usdToHbarWei(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("amount must be positive");
  return String(BigInt(Math.round((usd / USD_PER_HBAR) * 1e18)));
}

/** $X -> USDC base units (6 decimals). */
export function usdToUsdcUnits(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("amount must be positive");
  return String(Math.round(usd * 1e6));
}

/** HBAR wei -> display HBAR. */
export function hbarWeiToHbar(wei: string | number | bigint): number {
  return Number(wei) / 1e18;
}
