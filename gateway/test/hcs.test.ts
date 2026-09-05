import { describe, expect, it } from "vitest";
import { logReceiptHcs } from "../src/hcs.js";

describe("hcs audit", () => {
  it("never throws — bad key resolves null offline", async () => {
    const out = await logReceiptHcs(
      { topicId: "0.0.1", operatorId: "0.0.2", operatorKey: "0xZZZ-invalid" },
      "deadbeef",
    );
    expect(out).toBeNull();
  }, 15000);
});
