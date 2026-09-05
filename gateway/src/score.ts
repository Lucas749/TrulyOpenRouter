import type { HostInfo } from "./registry.js";

export interface ScoreWeights {
  price: number;
  latency: number;
  stake: number;
  reliability: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { price: 0.5, latency: 0.25, stake: 0.1, reliability: 0.15 };

/// @notice Cheapest-fastest-staked-reliable wins. Lower score = better. Pure function, tested.
export function scoreHost(h: HostInfo, w: ScoreWeights = DEFAULT_WEIGHTS): number {
  const price = Number(h.pricePerReq) + Number(h.pricePer1kTokens);
  const priceTerm = Math.log10(1 + price);
  const latencyTerm = Math.log10(1 + Math.max(0, h.latencyMs));
  const stakeTerm = 1 / (1 + Number(h.stake) / 1e18);
  const reliabilityTerm = 1 - Math.min(1, Math.max(0, h.reliability));
  return w.price * priceTerm + w.latency * latencyTerm + w.stake * stakeTerm + w.reliability * reliabilityTerm;
}

/// @notice Best host first. Ties broken by larger stake.
export function rankHosts(hosts: HostInfo[], w: ScoreWeights = DEFAULT_WEIGHTS): HostInfo[] {
  return [...hosts]
    .filter((h) => h.active)
    .sort((a, b) => scoreHost(a, w) - scoreHost(b, w) || Number(b.stake - a.stake));
}
