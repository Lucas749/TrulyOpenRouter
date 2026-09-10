import { BaseError, ContractFunctionRevertedError, formatEther, parseEther } from "viem";

export const DEFAULT_STAKE_HBAR = 4;
export const GAS_RESERVE_WEI = 10n ** 18n;

// Hedera contract values are tinybar; JSON-RPC transaction values use weibars.
export function registryValueWei(value: bigint, chainId: number): bigint {
  return [295, 296, 297, 298].includes(chainId) ? value * 10n ** 10n : value;
}

export function registrationStake(minimum: bigint, chainId: number, requested?: string): bigint {
  const minWei = registryValueWei(minimum, chainId);
  if (requested !== undefined && !/^\d+(\.\d{1,8})?$/.test(requested)) {
    throw new Error("Stake must be a positive HBAR amount with at most 8 decimal places.");
  }
  const stakeWei = parseEther(requested ?? String(DEFAULT_STAKE_HBAR));
  if (stakeWei <= 0n) throw new Error("Stake must be greater than zero.");
  if (requested !== undefined && stakeWei < minWei) {
    throw new Error(`Registry requires at least ${formatEther(minWei)} HBAR. Increase --stake-hbar or omit it to use the minimum.`);
  }
  return stakeWei < minWei ? minWei : stakeWei;
}

export class FundingRequiredError extends Error {
  readonly funding;
  constructor(address: string, balanceWei: bigint, stakeWei: bigint, rpcUrl: string) {
    const totalWei = stakeWei + GAS_RESERVE_WEI;
    const needed = formatEther(totalWei - balanceWei);
    super(`Add ${needed} testnet HBAR to your host wallet.\nHost: ${address}\nBalance: ${formatEther(balanceWei)} HBAR · Target: ${formatEther(totalWei)} HBAR\nStake: ${formatEther(stakeWei)} HBAR · Gas reserve: 1 HBAR`);
    this.funding = { address, stakeHbar: formatEther(stakeWei), totalHbar: formatEther(totalWei), totalWei: totalWei.toString(), rpcUrl };
  }
}

export function registrationError(error: unknown, chainId: number): string {
  const revert = error instanceof BaseError
    ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    : null;
  if (revert instanceof ContractFunctionRevertedError) {
    const data = revert.data;
    if (data?.errorName === "InsufficientStake") {
      const [sent, required] = data.args as [bigint, bigint];
      return `Registration needs ${formatEther(registryValueWei(required, chainId))} HBAR of stake; the transaction supplied ${formatEther(registryValueWei(sent, chainId))} HBAR.`;
    }
    if (data?.errorName === "AlreadyRegistered") return "This host is already registered. Rerun quickstart to resume serving.";
    if (data?.errorName === "TimelockActive") return "The previous stake is still locked. Release it after the unlock time before registering again.";
  }
  return error instanceof BaseError ? error.shortMessage : String((error as Error)?.message ?? error).split("\n")[0];
}
