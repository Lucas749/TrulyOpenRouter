// Money display: delivered units -> USD. 1e5 units = 1 credit = $0.001
// BY DEFINITION (SPEC money rule), so $ = units / 1e8. Pure display math,
// never a market rate. CLIENT-SAFE.

export function unitsToUsd(units: string | number | null | undefined): number | null {
  if (units === null || units === undefined) return null;
  const n = Number(units);
  if (!Number.isFinite(n) || n < 0) return null;
  return n / 1e8;
}

export function usdLabel(units: string | number | null | undefined): string {
  const v = unitsToUsd(units);
  if (v === null) return "—";
  if (v === 0) return "$0";
  if (v < 0.0001) return `$${v.toExponential(1)}`;
  return `$${v.toFixed(4)}`;
}
