import { type Address, type PublicClient, parseAbi } from "viem";

export const REGISTRY_ABI = parseAbi([
  "function eligibleHosts(string modelId) view returns (address[])",
  "function getHost(address host) view returns ((string endpoint, string modelId, bytes32 modelDigest, bytes32 imageDigest, uint256 pricePerReq, uint256 pricePer1kTokens, bytes teePubkey, uint256 stake, bool active, uint64 registeredAt, uint64 lastHeartbeat, uint64 releaseAfter, bool challenged))",
]);

export interface HostInfo {
  address: Address;
  endpoint: string;
  modelId: string;
  modelDigest: `0x${string}`;
  pricePerReq: bigint;
  pricePer1kTokens: bigint;
  stake: bigint;
  active: boolean;
  lastHeartbeat: number;
  latencyMs: number;
  reliability: number; // 0..1 success rate over recent receipts
}

type Reader = Pick<PublicClient, "readContract">;

/// @notice Active onchain hosts for a model. Latency/reliability are gateway-observed (in-memory).
export async function fetchEligibleHosts(
  client: Reader,
  registry: Address,
  modelId: string,
): Promise<HostInfo[]> {
  const addrs = (await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "eligibleHosts",
    args: [modelId],
  })) as Address[];

  const raws = await Promise.all(
    addrs.map((a) =>
      client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "getHost", args: [a] }),
    ),
  );

  return raws.map((h: any, i: number) => ({
    address: addrs[i],
    endpoint: h.endpoint ?? h[0],
    modelId: h.modelId ?? h[1],
    modelDigest: (h.modelDigest ?? h[2]) as `0x${string}`,
    pricePerReq: BigInt(h.pricePerReq ?? h[4]),
    pricePer1kTokens: BigInt(h.pricePer1kTokens ?? h[5]),
    stake: BigInt(h.stake ?? h[7]),
    active: Boolean(h.active ?? h[8]),
    lastHeartbeat: Number(h.lastHeartbeat ?? h[10]),
    latencyMs: 250, // default until observed; scorer refines with live EMA
    reliability: 1,
  }));
}
