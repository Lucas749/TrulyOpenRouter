import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ledgerApproval, quoteWithdrawal, submitWithdrawal, type WithdrawalQuote } from "../src/withdraw.js";

const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
const vault = `0x${"2".repeat(40)}` as const;
const quote: WithdrawalQuote = { address: account.address, vault, credits: 900n, tinybar: 90000000n, gas: 120000n, gasPrice: 1n, maxFeeWei: 120000n };
const context = () => ({ account, network: { vault }, publicClient: {
  readContract: vi.fn(async ({ functionName }) => functionName === "hostEarnings" ? 900n : 100000n),
  estimateContractGas: vi.fn(async () => 100000n), getGasPrice: vi.fn(async () => 1n), getBalance: vi.fn(async () => 1000000n),
  waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
} });

describe("earnings withdrawals", () => {
  it("quotes credits as HBAR and includes a bounded fee", async () => {
    expect(await quoteWithdrawal(context() as any)).toEqual(quote);
    const ctx = context(); ctx.publicClient.getBalance.mockResolvedValue(0n);
    await expect(quoteWithdrawal(ctx as any)).rejects.toThrow("withdrawal fee");
  });
  it("requires a confirmed successful receipt", async () => {
    const ctx = context(), wallet = { writeContract: vi.fn(async () => `0x${"a".repeat(64)}`) };
    expect(await submitWithdrawal(ctx as any, quote, wallet as any)).toMatch(/^0xa{64}$/);
    ctx.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await expect(submitWithdrawal(ctx as any, quote, wallet as any)).rejects.toThrow("reverted");
    ctx.publicClient.waitForTransactionReceipt.mockRejectedValue(new Error("timeout"));
    await expect(submitWithdrawal(ctx as any, quote, wallet as any)).rejects.toThrow("confirmation is pending");
  });
  it("rejects another destination before submitting", async () => {
    const wallet = { writeContract: vi.fn() };
    await expect(submitWithdrawal(context() as any, { ...quote, vault: account.address }, wallet as any)).rejects.toThrow("changed");
    expect(wallet.writeContract.mock.calls).toHaveLength(0);
  });
  it("verifies the device's signature and closes the connection on rejection", async () => {
    const device = { address: vi.fn(async () => account.address), sign: vi.fn(async (message: string) => account.signMessage({ message })), close: vi.fn(async () => {}) };
    expect(await ledgerApproval(quote, device, account.address)).toBe(account.address);
    expect(device.sign.mock.calls[0][0]).toContain("withdraw all available earnings to the host wallet");
    await expect(ledgerApproval(quote, device, vault)).rejects.toThrow("does not match");
    device.sign.mockRejectedValue(new Error("Rejected on device"));
    await expect(ledgerApproval(quote, device)).rejects.toThrow("Rejected on device");
    expect(device.close.mock.calls).toHaveLength(3);
  });
});
