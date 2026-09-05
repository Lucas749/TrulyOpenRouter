import { describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getQuorumKey, hasQuorumKey, saveQuorumKey } from "../lib/quorum-keys";

describe("quorum-keys store", () => {
  it("roundtrips keys, misses cleanly", () => {
    process.env.TOR_PRIVY_KEYS_DIR = mkdtempSync(join(tmpdir(), "tor-qk-"));
    expect(hasQuorumKey("q1")).toBe(false);
    expect(getQuorumKey("q1")).toBeNull();
    saveQuorumKey("q1", "wallet-auth:abc123");
    expect(hasQuorumKey("q1")).toBe(true);
    expect(getQuorumKey("q1")).toBe("wallet-auth:abc123");
    delete process.env.TOR_PRIVY_KEYS_DIR;
  });
});
