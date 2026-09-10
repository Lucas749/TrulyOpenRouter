import { type Address, type PublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const REGISTRY_ABI = parseAbi([
  "function eligibleHosts(string modelId) view returns (address[])",
  "function getHost(address host) view returns ((string endpoint, string modelId, bytes32 modelDigest, bytes32 imageDigest, uint256 pricePerReq, uint256 pricePer1kTokens, bytes teePubkey, uint256 stake, bool active, uint64 registeredAt, uint64 lastHeartbeat, uint64 releaseAfter, bool challenged))",
  "function challenge(address host, bytes32 receiptId)",
]);

export interface HostInfo {
  address: Address;
  registry?: Address;
  registeredModelId?: string;
  registeredEndpoint?: string;
  paused?: boolean;
  endpoint: string;
  modelId: string;
  modelDigest: `0x${string}`;
  pricePerReq: bigint;
  pricePer1kTokens: bigint;
  stake: bigint;
  active: boolean;
  challenged?: boolean;
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
    registry,
    endpoint: h.endpoint ?? h[0],
    modelId: h.modelId ?? h[1],
    modelDigest: (h.modelDigest ?? h[2]) as `0x${string}`,
    pricePerReq: BigInt(h.pricePerReq ?? h[4]),
    pricePer1kTokens: BigInt(h.pricePer1kTokens ?? h[5]),
    stake: BigInt(h.stake ?? h[7]),
    active: Boolean(h.active ?? h[8]),
    challenged: Boolean(h.challenged ?? h[12] ?? false),
    lastHeartbeat: Number(h.lastHeartbeat ?? h[10]),
    latencyMs: 250, // default until observed; scorer refines with live EMA
    reliability: 1,
  }));
}

export interface ChallengeConfig {
  rpcUrl: string;
  registry: Address;
  operatorKey: `0x${string}`; // any funded key: challenge() is permissionless
}

/// @notice Flag a host onchain after failed verification. Queues for review only —
/// the contract never auto-slashes (v1 stub). Wallet client injectable for tests.
export async function fileChallenge(
  cfg: ChallengeConfig,
  host: string,
  receiptId: `0x${string}`,
  wallet?: { writeContract: (args: any) => Promise<string> },
): Promise<string> {
  const w =
    wallet ??
    createWalletClient({ account: privateKeyToAccount(cfg.operatorKey), transport: http(cfg.rpcUrl) });
  return w.writeContract({
    address: cfg.registry,
    abi: REGISTRY_ABI,
    functionName: "challenge",
    args: [host as Address, receiptId],
    chain: undefined,
  });
}
