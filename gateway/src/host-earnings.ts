import { parseAbi, type Address, type PublicClient } from "viem";

export const HOST_EARNINGS_ABI = parseAbi([
  "function hostEarnings(address) view returns (uint256)",
  "function REFUND_RATE_WEI_PER_CREDIT() view returns (uint256)",
]);

export async function hostEarnings(client: Pick<PublicClient, "readContract">, vault: Address, host: Address) {
  const [credits, rate] = await Promise.all([
    client.readContract({ address: vault, abi: HOST_EARNINGS_ABI, functionName: "hostEarnings", args: [host] }),
    client.readContract({ address: vault, abi: HOST_EARNINGS_ABI, functionName: "REFUND_RATE_WEI_PER_CREDIT" }),
  ]);
  return { credits: String(credits), tinybar: String(credits * rate), rate };
}
