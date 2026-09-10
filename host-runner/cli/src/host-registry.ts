import { parseAbi, type Address, type PublicClient } from "viem";

const ABI = parseAbi([
  "function getHost(address) view returns ((string endpoint, string modelId, bytes32 modelDigest, bytes32 imageDigest, uint256 pricePerReq, uint256 pricePer1kTokens, bytes teePubkey, uint256 stake, bool active, uint64 registeredAt, uint64 lastHeartbeat, uint64 releaseAfter, bool challenged))",
]);

// Keep existing hosts and pending withdrawals on their original registry.
// Fresh keys use the primary registry, which carries the current stake minimum.
export async function findHostRegistry(
  client: Pick<PublicClient, "readContract">,
  primary: Address,
  legacy: Address[],
  address: Address,
) {
  const registries = [...new Set([primary, ...legacy].map((r) => r.toLowerCase() as Address))];
  const records = [];
  for (const registry of registries) {
    const host = await client.readContract({ address: registry, abi: ABI, functionName: "getHost", args: [address] });
    if (host.active) return { registry, host };
    records.push({ registry, host });
  }
  return records.find(({ host }) => host.stake > 0n) ?? records[0];
}
