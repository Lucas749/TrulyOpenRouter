import { describe, expect, it } from "vitest";
import { friendlyTxError } from "./tx-errors";

describe("friendlyTxError", () => {
  it("maps rejection to retry", () => {
    expect(friendlyTxError(new Error("User rejected the request"))).toContain("retry");
  });

  it("maps empty wallets to fund-first", () => {
    expect(friendlyTxError(new Error("insufficient funds for gas"))).toContain("fund first");
  });

  it("strips the hashio RPC dump, keeps no JSON", () => {
    const dump = new Error(
      'Transaction creation failed. URL: https://testnet.hashio.io/api Request body: {"method":"eth_sendRawTransaction","params":["0x02f88e8201288080808094d75c46c0e82',
    );
    const out = friendlyTxError(dump);
    expect(out).not.toContain("eth_sendRawTransaction");
    expect(out).not.toContain(" Request body");
    expect(out.length).toBeLessThanOrEqual(140);
  });

  it("truncates anything else", () => {
    expect(friendlyTxError(new Error("x".repeat(300))).length).toBeLessThanOrEqual(141);
  });
});
