import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createWalletClient, formatEther, http, parseAbi, verifyMessage, type Address, type Hex } from "viem";
import { hostContext } from "./host-runtime.js";
import { loadConfig, saveConfig } from "./config.js";

export const WITHDRAW_ABI = parseAbi([
  "function hostEarnings(address) view returns (uint256)",
  "function REFUND_RATE_WEI_PER_CREDIT() view returns (uint256)",
  "function withdraw()", "error NothingToWithdraw()",
]);
export interface WithdrawalQuote { address: Address; vault: Address; credits: bigint; tinybar: bigint; gas: bigint; gasPrice: bigint; maxFeeWei: bigint }
type Context = Awaited<ReturnType<typeof hostContext>>;

export async function quoteWithdrawal(ctx: Context): Promise<WithdrawalQuote> {
  const vault = ctx.network.vault as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error("The gateway has no earnings vault configured.");
  const [credits, rate] = await Promise.all([
    ctx.publicClient.readContract({ address: vault, abi: WITHDRAW_ABI, functionName: "hostEarnings", args: [ctx.account.address] }),
    ctx.publicClient.readContract({ address: vault, abi: WITHDRAW_ABI, functionName: "REFUND_RATE_WEI_PER_CREDIT" }),
  ]);
  if (credits === 0n) throw new Error("No earnings to withdraw yet. Your stake is separate and stays locked.");
  const [estimate, gasPrice, balance] = await Promise.all([
    ctx.publicClient.estimateContractGas({ address: vault, abi: WITHDRAW_ABI, functionName: "withdraw", account: ctx.account }),
    ctx.publicClient.getGasPrice(), ctx.publicClient.getBalance({ address: ctx.account.address }),
  ]);
  const gas = estimate * 12n / 10n, maxFeeWei = gas * gasPrice;
  if (balance < maxFeeWei) throw new Error(`Host wallet needs ${formatEther(maxFeeWei)} HBAR for the withdrawal fee.`);
  return { address: ctx.account.address, vault, credits, tinybar: credits * rate, gas, gasPrice, maxFeeWei };
}

export function withdrawalIntent(quote: WithdrawalQuote, nonce: string, expiresAt: number): string {
  return ["TrulyOpenRouter withdrawal approval", "chain: 296", `host: ${quote.address.toLowerCase()}`, `vault: ${quote.vault.toLowerCase()}`,
    "action: withdraw all available earnings to the host wallet", `currentTinybar: ${quote.tinybar}`, `maxFeeWeibar: ${quote.maxFeeWei}`, `nonce: ${nonce}`, `expiresAt: ${expiresAt}`].join("\n");
}

export interface LedgerDevice {
  address(): Promise<Address>;
  sign(message: string): Promise<Hex>;
  close(): Promise<void>;
}
export async function openLedger(): Promise<LedgerDevice> {
  try {
    // Use the Node builds; the browser ESM bundles use extensionless imports.
    const require = createRequire(import.meta.url);
    const Transport = require("@ledgerhq/hw-transport-node-hid").default;
    const Eth = require("@ledgerhq/hw-app-eth").default;
    const transport = await Transport.create(15000, 15000);
    transport.setExchangeTimeout(120000);
    const eth = new Eth(transport), path = "44'/60'/0'/0/0";
    return {
      address: async () => (await eth.getAddress(path, true)).address as Address,
      sign: async message => {
        const s = await eth.signPersonalMessage(path, Buffer.from(message, "utf8").toString("hex"));
        return `0x${s.r}${s.s}${Number(s.v).toString(16).padStart(2, "0")}`;
      },
      close: () => transport.close(),
    };
  } catch {
    throw new Error("Ledger is unavailable. Connect and unlock it, open the Ethereum app, and close other wallet apps. If USB support is missing, reinstall the CLI optional dependencies.");
  }
}

export async function ledgerApproval(quote: WithdrawalQuote, device: LedgerDevice, expected?: Address): Promise<Address> {
  try {
    const address = await device.address();
    if (expected && address.toLowerCase() !== expected.toLowerCase()) throw new Error("This Ledger does not match the device linked to your host.");
    const expiresAt = Date.now() + 180000;
    const message = withdrawalIntent(quote, randomUUID(), expiresAt);
    const signature = await device.sign(message);
    if (Date.now() > expiresAt || !await verifyMessage({ address, message, signature })) throw new Error("Ledger approval is invalid or expired. Nothing was submitted.");
    return address;
  } finally { await device.close(); }
}

export async function submitWithdrawal(ctx: Context, quote: WithdrawalQuote, wallet = createWalletClient({ account: ctx.account, transport: http(ctx.network.rpcUrl) })): Promise<Hex> {
  if (quote.address.toLowerCase() !== ctx.account.address.toLowerCase() || quote.vault.toLowerCase() !== ctx.network.vault.toLowerCase()) throw new Error("Withdrawal account or vault changed. Review it again.");
  const hash = await wallet.writeContract({ address: quote.vault, abi: WITHDRAW_ABI, functionName: "withdraw", chain: undefined, gas: quote.gas, gasPrice: quote.gasPrice });
  let receipt;
  try { receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 120000 }); }
  catch { throw new Error(`Withdrawal submitted; confirmation is pending. Check transaction ${hash} before retrying.`); }
  if (receipt.status !== "success") throw new Error(`Withdrawal reverted. Earnings were not withdrawn. Transaction: ${hash}`);
  return hash;
}

export async function withdrawEarnings(gateway: string | undefined, method: "softkey" | "ledger", confirm: (quote: WithdrawalQuote) => Promise<boolean>, progress = (_message: string) => {}): Promise<string> {
  progress("Reading earnings and estimating the transaction fee…");
  const ctx = await hostContext(gateway);
  const quote = await quoteWithdrawal(ctx);
  if (!await confirm(quote)) return "Withdrawal cancelled. Nothing was submitted.";
  if (method === "ledger") {
    progress("Confirm the address and withdrawal message on your Ledger. Open the Ethereum app.");
    const address = await ledgerApproval(quote, await openLedger(), loadConfig().ledgerApprovalAddress);
    saveConfig({ ...loadConfig(), ledgerApprovalAddress: address });
  }
  progress("Submitting withdrawal with the host key and waiting for confirmation…");
  const tx = await submitWithdrawal(ctx, quote);
  return `Earnings withdrawn to ${quote.address}. Confirmed transaction: ${tx}`;
}
