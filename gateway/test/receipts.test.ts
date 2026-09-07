import { describe, expect, it } from "vitest";
import { MemoryReceiptLog, buildReceipt, sha256hex } from "../src/receipts.js";

describe("receipts", () => {
  it("hashes deterministically from hashes-only input", () => {
    const a = buildReceipt({
      promptHash: sha256hex("hi"),
      completionHash: sha256hex("hello"),
      modelDigest: "0xabc",
      host: "0x1111111111111111111111111111111111111111",
      priceWei: "1000",
      latencyMs: 120,
    });
    const b = buildReceipt({ ...a });
    expect(a.id).toBe(b.id);
    expect(a.id).toHaveLength(64);
  });

  it("logs list/get in reverse-chronological order", async () => {
    const log = new MemoryReceiptLog();
    const r1 = buildReceipt({ promptHash: "p1", completionHash: "c1", modelDigest: "m", host: "h", priceWei: "1", latencyMs: 1 }, 1);
    const r2 = buildReceipt({ promptHash: "p2", completionHash: "c2", modelDigest: "m", host: "h", priceWei: "1", latencyMs: 1 }, 2);
    await log.append(r1);
    await log.append(r2);
    expect((await log.list()).map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect((await log.get(r1.id))?.promptHash).toBe("p1");
  });
});
