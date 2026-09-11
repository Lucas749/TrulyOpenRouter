import { AccountBalanceQuery, AccountId, Client, Hbar, PrivateKey, Transaction, TransactionId, TransactionReceiptQuery, TransferTransaction } from "@hiero-ledger/sdk";
import type { FaucetGrant, FaucetSender } from "./faucet.js";
import { FAUCET_HBAR } from "./faucet.js";

// The funding wallet is separate from the gateway operator and host wallets.
// Network selection is deliberately fixed: this service only distributes test HBAR.
export class HederaFaucetSender implements FaucetSender {
  readonly address: string;
  private key: PrivateKey;
  private client: Client;

  constructor(readonly accountId: string, privateKey: string) {
    if (!/^0\.0\.[1-9]\d*$/.test(accountId)) throw new Error("FAUCET_ACCOUNT_ID must be a native testnet account ID");
    this.key = PrivateKey.fromStringECDSA(privateKey.replace(/^0x/, ""));
    this.address = `0x${this.key.publicKey.toEvmAddress()}`;
    this.client = Client.forTestnet().setOperator(accountId, this.key)
      .setDefaultRegenerateTransactionId(false).setMaxAttempts(2).setRequestTimeout(15000);
  }

  async balanceTinybar(): Promise<bigint> {
    const balance = await new AccountBalanceQuery().setAccountId(this.accountId).execute(this.client);
    return BigInt(balance.hbars.toTinybars().toString());
  }

  async prepare(address: string): Promise<{ transactionId: string; bytes: string }> {
    const tx = await new TransferTransaction()
      .addHbarTransfer(this.accountId, new Hbar(-FAUCET_HBAR))
      .addHbarTransfer(AccountId.fromEvmAddress(0, 0, address), new Hbar(FAUCET_HBAR))
      .setTransactionMemo("TrulyOpenRouter host funding")
      .setMaxTransactionFee(new Hbar(1))
      .setRegenerateTransactionId(false)
      .freezeWith(this.client).sign(this.key);
    return { transactionId: tx.transactionId!.toString(), bytes: Buffer.from(tx.toBytes()).toString("base64") };
  }

  async settle(grant: FaucetGrant): Promise<FaucetGrant["status"]> {
    // Mirror history resolves old confirmations after consensus receipt expiry.
    const mirrorId = grant.transaction_id.replace("@", "-").replace(/\.(\d+)$/, "-$1");
    const mirror = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${mirrorId}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (mirror?.ok) {
      const data = await mirror.json() as { transactions?: { result: string }[] };
      const results = data.transactions?.map(t => t.result) ?? [];
      if (results.includes("SUCCESS")) return "sent";
      if (results.some(r => r !== "DUPLICATE_TRANSACTION" && r !== "UNKNOWN")) return "failed";
    }
    try {
      const tx = Transaction.fromBytes(Buffer.from(grant.signed_transaction, "base64"));
      tx.setRegenerateTransactionId(false);
      await tx.execute(this.client);
    } catch {
      // A duplicate or a transport timeout can follow a successful transfer.
      // Resolve its original receipt, never sign a replacement transaction.
    }
    try {
      const receipt = await new TransactionReceiptQuery().setTransactionId(TransactionId.fromString(grant.transaction_id))
        .setValidateStatus(false).setIncludeDuplicates(true).execute(this.client);
      const statuses = [receipt, ...receipt.duplicates].map(r => r.status.toString());
      if (statuses.includes("SUCCESS")) return "sent";
      if (statuses.some(s => !["UNKNOWN", "RECEIPT_NOT_FOUND", "DUPLICATE_TRANSACTION"].includes(s))) return "failed";
    } catch { /* Keep the grant pending until consensus or mirror confirms it. */ }
    return "pending";
  }
}
