import { createHash } from "crypto";

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface ReceiptInput {
  promptHash: string;
  completionHash: string;
  modelDigest: string;
  host: string; // host address or "fallback"
  priceWei: string;
  latencyMs: number;
}

export interface Receipt extends ReceiptInput {
  id: string; // sha256 over all fields — the verifiable handle
  ts: number;
}

/// @notice Bodies never touch a receipt — hashes only (see privacy split, SPEC §1b…§4).
export function buildReceipt(input: ReceiptInput, ts = Date.now()): Receipt {
  const id = sha256hex(
    [input.promptHash, input.completionHash, input.modelDigest, input.host, input.priceWei, input.latencyMs].join("|"),
  );
  return { ...input, id, ts };
}

export class MemoryReceiptLog {
  private items: Receipt[] = [];

  append(r: Receipt): void {
    this.items.push(r);
  }

  list(limit = 50): Receipt[] {
    return this.items.slice(-limit).reverse();
  }

  get(id: string): Receipt | undefined {
    return this.items.find((r) => r.id === id);
  }
}
