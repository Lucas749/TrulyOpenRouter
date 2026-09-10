import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { quoteWithdrawal, submitWithdrawal, WITHDRAW_ABI } from "../src/withdraw.js";

// Explicit local-chain proof: forge build in contracts, then WITHDRAW_E2E=1 npm test.
it.skipIf(process.env.WITHDRAW_E2E !== "1")("withdraws nonzero vault earnings and confirms the host receives the funds", async () => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const publicClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }), pollingInterval: 20 });
  const mnemonic = "test test test test test test test test test test test junk";
  const owner = mnemonicToAccount(mnemonic);
  const host = mnemonicToAccount(mnemonic, { addressIndex: 1 });
  const wallet = createWalletClient({ account: owner, transport: http(rpcUrl) });
  const chain = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) { try { await publicClient.getBlockNumber(); break; } catch { await wait(100); } }
    const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/SubscriptionVault.sol/SubscriptionVault.json", import.meta.url), "utf8"));
    const deployed = await publicClient.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address, 10000n, 100000n], chain: undefined }) });
    const vault = deployed.contractAddress!;
    const tx = async (functionName: string, args: unknown[], value?: bigint) => publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: vault, abi: artifact.abi, functionName, args, value, chain: undefined }) });
    await tx("setPlan", [0n, 100000000n, 1000n]);
    await tx("subscribe", [0n], 100000000n);
    await tx("debit", [owner.address, host.address, 1000n, `0x${"1".repeat(64)}`]);
    const ctx = { gateway: "", account: host, publicClient, network: { vault, rpcUrl } };
    const quote = await quoteWithdrawal(ctx);
    expect(quote.credits).toBe(900n);
    expect(quote.tinybar).toBe(90000000n);
    const before = await publicClient.getBalance({ address: host.address });
    const hash = await submitWithdrawal(ctx, quote);
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const after = await publicClient.getBalance({ address: host.address });
    expect(after + receipt.gasUsed * receipt.effectiveGasPrice - before).toBe(90000000n);
    expect(await publicClient.readContract({ address: vault, abi: WITHDRAW_ABI, functionName: "hostEarnings", args: [host.address] })).toBe(0n);
    await expect(quoteWithdrawal(ctx)).rejects.toThrow("No earnings");
  } finally {
    const exited = new Promise<void>(resolve => chain.once("exit", () => resolve()));
    chain.kill("SIGTERM"); await exited;
  }
}, 20000);
