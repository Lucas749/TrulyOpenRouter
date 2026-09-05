import { AccountId, Client, PrivateKey, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

export interface HcsConfig {
  topicId: string;
  operatorId: string;
  operatorKey: string; // hex ECDSA, testnet only in this repo
}

/// @notice Append a receipt hash to the HCS audit topic. Best-effort: never throws
/// (audit must not break serving). Returns the sequence number or null.
export async function logReceiptHcs(cfg: HcsConfig, receiptId: string): Promise<string | null> {
  let client: ReturnType<typeof Client.forTestnet> | null = null;
  try {
    client = Client.forTestnet().setOperator(
      AccountId.fromString(cfg.operatorId),
      PrivateKey.fromStringECDSA(cfg.operatorKey),
    );
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(cfg.topicId))
      .setMessage(receiptId)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    return String((receipt as any).topicSequenceNumber ?? "");
  } catch {
    return null;
  } finally {
    try {
      await client?.close();
    } catch {}
  }
}
