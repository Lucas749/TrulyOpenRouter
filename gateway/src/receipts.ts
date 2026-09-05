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
  tokensIn?: number; // from upstream usage; 0 when unreported
  tokensOut?: number;
  amountCredits?: string; // metered settle amount; "0" when unsettled
  modelId?: string; // for per-model aggregates
  user?: string; // payer handle: key:<prefix> or "dev" — pseudonymous, for usage history
}

// Money rule (SPEC §7): 1 credit ≡ $0.001 BY DEFINITION. Displays derive $ as
// credits × 0.001 — a defined unit conversion, never a market rate. Onchain wei
// amounts map 1:1 to credit base units at the documented testnet rate.

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

  /// @notice Patch a receipt after the fact (e.g. settled amount). No-op when unknown.
  annotate(id: string, patch: Partial<Receipt>): void {
    const r = this.get(id);
    if (r) Object.assign(r, patch);
  }
}
