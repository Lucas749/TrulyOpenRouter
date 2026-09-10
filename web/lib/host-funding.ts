import { createPublicClient, formatEther, http, parseAbi, parseEther } from "viem";

export function hostFunding(minimum: bigint, chainId: number, requested: string | null = null) {
  const minWei = [295, 296, 297, 298].includes(chainId) ? minimum * BigInt(1e10) : minimum;
  const preferred = requested && /^\d+(\.\d{1,8})?$/.test(requested) ? parseEther(requested) : parseEther("4");
  const stakeWei = preferred > minWei ? preferred : minWei;
  return { stakeHbar: formatEther(stakeWei), totalHbar: formatEther(stakeWei + parseEther("1")) };
}

export async function loadHostFunding(requested: string | null = null) {
  const response = await fetch("/api/gw/api/config");
  if (!response.ok) throw new Error("Cannot read chain configuration");
  const config = await response.json();
  if (!config.registry || !config.rpcUrl || !config.chainId) throw new Error("Chain configuration is incomplete");
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const minimum = await client.readContract({
    address: config.registry, abi: parseAbi(["function MIN_STAKE() view returns (uint256)"]), functionName: "MIN_STAKE",
  });
  return hostFunding(minimum, Number(config.chainId), requested);
}
