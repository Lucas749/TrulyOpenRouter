import { decodeEventLog, encodeFunctionData, formatEther, formatUnits, keccak256, parseAbi, type Address, type Hex } from "viem";
import { loadConfig, saveConfig } from "./config.js";
import { findHostRegistry } from "./host-registry.js";
import { hostApi, hostContext } from "./host-runtime.js";
import { quoteWithdrawal, submitWithdrawal } from "./withdraw.js";

// Team earnings from the host machine. `team link` signs a team owner's one-time link
// terms with this host key after checking they name this host, its registry, and the
// code. `collect` withdraws vault earnings to the host and sends them to the linked
// team wallet. The transfer is signed and saved before broadcast, so a retry resumes
// the same transaction and never withdraws or transfers twice for one collection.

type Context = Awaited<ReturnType<typeof hostContext>>;
export const TRANSFER_GAS = 50_000n;
export const USDC_TRANSFER_GAS = 150_000n;
export const HOST_GAS_RESERVE_WEI = 5n * 10n ** 17n; // 0.5 HBAR stays on the host for fees
export const TEST_USDC = "0x0000000000000000000000000000000000068cda" as Address;
const TEST_USDC_TOKEN_ID = "0.0.429274";
const WEIBAR_PER_TINYBAR = 10_000_000_000n;
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const WITHDRAWN = parseAbi(["event Withdrawn(address indexed host, uint256 amount)"]);

export interface LinkTerms { orgId: string; teamName: string; destination: string; registry: string; expiresAt: number; message: string }
export interface TeamLink { orgId: string; teamName: string; destination: string; registry: string; linkedAt: number }
export interface CollectionReview { asset: "hbar" | "usdc"; teamName: string; destination: string; amount: string; maxFeeHbar: string }
export interface PendingCollection {
  asset: "hbar" | "usdc";
  orgId: string;
  destination: string;
  withdrawTx?: Hex;
  withdrawnWei?: string;
  usdcUnits?: string;
  transfer?: { raw: Hex; hash: Hex; amount: string };
}

/// @notice Sign the owner's link terms with this host key once they match this host.
export async function linkTeam(code: string, ctx: Context, confirm: (terms: LinkTerms) => Promise<boolean>): Promise<string> {
  if (!/^thl_[A-Za-z0-9_-]{8,}$/.test(code)) throw new Error("usage: tor-host team link <code from the team page>");
  const terms = (await hostApi(ctx.gateway, `/api/host-links/${encodeURIComponent(code)}?host=${ctx.account.address}`)) as LinkTerms;
  const { registry } = await findHostRegistry(ctx.publicClient, ctx.network.registry as Address, ctx.network.legacyRegistries ?? [], ctx.account.address);
  const lines = terms.message.split("\n");
  const expected = ["network: hedera-testnet (chain 296)", `registry: ${registry.toLowerCase()}`, `host: ${ctx.account.address.toLowerCase()}`, `destination: ${terms.destination.toLowerCase()}`, `nonce: ${code}`];
  if (terms.registry.toLowerCase() !== registry.toLowerCase() || expected.some((line) => !lines.includes(line))) {
    throw new Error("The link terms do not match this host. Nothing was signed.");
  }
  if (!(await confirm(terms))) return "Link cancelled. Nothing was signed.";
  const signature = await ctx.account.signMessage({ message: terms.message });
  const linked = (await hostApi(ctx.gateway, `/api/host-links/${encodeURIComponent(code)}`, { host: ctx.account.address, signature })) as TeamLink;
  return `Linked to ${linked.teamName}. Collected earnings go only to ${linked.destination}.`;
}

/// @notice Whether a Hedera account exists for the wallet and can hold test USDC.
export async function acceptsTestUsdc(address: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const base = "https://testnet.mirrornode.hedera.com/api/v1/accounts";
  const account = await fetcher(`${base}/${address}`, { signal: AbortSignal.timeout(10000) });
  if (!account.ok) return false;
  const { max_automatic_token_associations: slots } = (await account.json()) as { max_automatic_token_associations?: number };
  const tokens = await fetcher(`${base}/${address}/tokens?token.id=${TEST_USDC_TOKEN_ID}`, { signal: AbortSignal.timeout(10000) });
  const held = tokens.ok ? (((await tokens.json()) as { tokens?: unknown[] }).tokens ?? []).length > 0 : false;
  return held || slots === -1 || (slots ?? 0) > 0;
}

async function signTransfer(ctx: Context, to: Address, value: bigint, data: Hex | undefined, gas: bigint, gasPrice: bigint) {
  const nonce = await ctx.publicClient.getTransactionCount({ address: ctx.account.address, blockTag: "pending" });
  const raw = await ctx.account.signTransaction({ chainId: 296, to, value, data, gas, gasPrice, nonce, type: "legacy" });
  return { raw, hash: keccak256(raw) };
}

/// @notice Broadcast stored bytes unless already mined, then wait for the receipt.
async function settle(ctx: Context, leg: { raw: Hex; hash: Hex }): Promise<"success" | "reverted"> {
  const known = await ctx.publicClient.getTransactionReceipt({ hash: leg.hash }).catch(() => null);
  if (known) return known.status;
  await ctx.publicClient.sendRawTransaction({ serializedTransaction: leg.raw }).catch(() => undefined); // may already be known; the receipt decides
  try {
    return (await ctx.publicClient.waitForTransactionReceipt({ hash: leg.hash, timeout: 120000 })).status;
  } catch {
    throw new Error(`The team transfer was submitted; confirmation is pending. Run collect again to finish transaction ${leg.hash}.`);
  }
}

async function startHbar(ctx: Context, link: TeamLink, confirm: (r: CollectionReview) => Promise<boolean>, progress: (m: string) => void, wallet?: Parameters<typeof submitWithdrawal>[2]): Promise<PendingCollection | null> {
  const quote = await quoteWithdrawal(ctx);
  const review: CollectionReview = { asset: "hbar", teamName: link.teamName, destination: link.destination, amount: `${formatUnits(quote.tinybar, 8)} HBAR`, maxFeeHbar: formatEther(quote.maxFeeWei + TRANSFER_GAS * quote.gasPrice) };
  if (!(await confirm(review))) return null;
  progress("Withdrawing vault earnings to the host wallet…");
  const withdrawTx = await submitWithdrawal(ctx, quote, wallet);
  const receipt = await ctx.publicClient.getTransactionReceipt({ hash: withdrawTx });
  let withdrawn = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== quote.vault.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: WITHDRAWN, data: log.data, topics: log.topics });
      if (event.args.host.toLowerCase() === ctx.account.address.toLowerCase()) withdrawn += event.args.amount;
    } catch {
      // Other vault events are ignored.
    }
  }
  const pending: PendingCollection = { asset: "hbar", orgId: link.orgId, destination: link.destination, withdrawTx, withdrawnWei: String((withdrawn || quote.tinybar) * WEIBAR_PER_TINYBAR) };
  saveConfig({ ...loadConfig(), pendingCollection: pending });
  await hostApi(ctx.gateway, `/api/hosts/${ctx.account.address}/collections`, { asset: "hbar", withdrawTx }).catch(() => progress("The gateway records the withdrawal together with the transfer."));
  return pending;
}

async function startUsdc(ctx: Context, link: TeamLink, confirm: (r: CollectionReview) => Promise<boolean>, fetcher: typeof fetch): Promise<PendingCollection | null> {
  const units = await ctx.publicClient.readContract({ address: TEST_USDC, abi: ERC20, functionName: "balanceOf", args: [ctx.account.address] });
  if (units === 0n) throw new Error("No test USDC to collect on this host.");
  if (!(await acceptsTestUsdc(link.destination, fetcher))) {
    throw new Error("The team wallet cannot hold test USDC yet. It needs a Hedera account that accepts the token; deposit HBAR to the team wallet first, then retry.");
  }
  const gasPrice = await ctx.publicClient.getGasPrice();
  const review: CollectionReview = { asset: "usdc", teamName: link.teamName, destination: link.destination, amount: `${formatUnits(units, 6)} test USDC`, maxFeeHbar: formatEther(USDC_TRANSFER_GAS * gasPrice) };
  if (!(await confirm(review))) return null;
  return { asset: "usdc", orgId: link.orgId, destination: link.destination, usdcUnits: String(units) };
}

/// @notice Collect this host's HBAR vault earnings or test USDC into its linked team wallet.
export async function collectEarnings(
  ctx: Context,
  asset: "hbar" | "usdc",
  confirm: (review: CollectionReview) => Promise<boolean>,
  progress: (message: string) => void = () => {},
  deps: { wallet?: Parameters<typeof submitWithdrawal>[2]; fetcher?: typeof fetch } = {},
): Promise<string> {
  const link = (await hostApi(ctx.gateway, `/api/hosts/${ctx.account.address}/team-link`)) as TeamLink;
  let pending: PendingCollection | null | undefined = loadConfig().pendingCollection;
  if (pending && pending.destination.toLowerCase() !== link.destination.toLowerCase()) {
    throw new Error(`An unfinished collection to ${pending.destination} remains, but this host is now linked to ${link.destination}. Relink to the original team to finish it first.`);
  }
  if (pending && pending.asset !== asset) throw new Error(`Finish the unfinished collection first: tor-host collect${pending.asset === "usdc" ? " --usdc" : ""}`);
  if (pending) progress(`Resuming the unfinished collection${pending.withdrawTx ? ` after withdrawal ${pending.withdrawTx}` : ""}…`);
  else {
    pending = asset === "hbar" ? await startHbar(ctx, link, confirm, progress, deps.wallet) : await startUsdc(ctx, link, confirm, deps.fetcher ?? fetch);
    if (!pending) return "Collection cancelled. Nothing was submitted.";
  }

  if (!pending.transfer) {
    const gasPrice = await ctx.publicClient.getGasPrice();
    const destination = pending.destination as Address;
    if (asset === "hbar") {
      const balance = await ctx.publicClient.getBalance({ address: ctx.account.address });
      const spendable = balance - TRANSFER_GAS * gasPrice - HOST_GAS_RESERVE_WEI;
      const amount = BigInt(pending.withdrawnWei!) < spendable ? BigInt(pending.withdrawnWei!) : spendable;
      if (amount <= 0n) throw new Error(`The host keeps ${formatEther(HOST_GAS_RESERVE_WEI)} HBAR for fees. Add HBAR to ${ctx.account.address}, then run collect again.`);
      pending = { ...pending, transfer: { ...(await signTransfer(ctx, destination, amount, undefined, TRANSFER_GAS, gasPrice)), amount: String(amount) } };
    } else {
      const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [destination, BigInt(pending.usdcUnits!)] });
      pending = { ...pending, transfer: { ...(await signTransfer(ctx, TEST_USDC, 0n, data, USDC_TRANSFER_GAS, gasPrice)), amount: pending.usdcUnits! } };
    }
    saveConfig({ ...loadConfig(), pendingCollection: pending });
  }

  progress(`Sending to the team wallet ${pending.destination}…`);
  if ((await settle(ctx, pending.transfer!)) !== "success") {
    saveConfig({ ...loadConfig(), pendingCollection: { ...pending, transfer: undefined } });
    throw new Error(`The team transfer reverted${pending.withdrawTx ? "; the withdrawal is kept" : ""}. Run collect again to retry. Transaction: ${pending.transfer!.hash}`);
  }
  await hostApi(ctx.gateway, `/api/hosts/${ctx.account.address}/collections`, { asset, withdrawTx: pending.withdrawTx, transferTx: pending.transfer!.hash });
  saveConfig({ ...loadConfig(), pendingCollection: undefined });
  const amount = asset === "hbar" ? `${formatEther(BigInt(pending.transfer!.amount))} HBAR` : `${formatUnits(BigInt(pending.transfer!.amount), 6)} test USDC`;
  return `Collected ${amount} into ${link.teamName}. ${pending.withdrawTx ? `Withdrawal ${pending.withdrawTx}; ` : ""}transfer ${pending.transfer!.hash}.`;
}
