import { describe, expect, it } from "vitest";
import { ContractFunctionRevertedError, encodeErrorResult, parseAbi } from "viem";
import { registrationError, registrationStake, registryValueWei } from "../src/registration.js";

describe("registration units", () => {
  it("uses 4 HBAR on the lower-stake registry", () => {
    expect(registrationStake(400_000_000n, 296)).toBe(4n * 10n ** 18n);
  });
  it("still honors the legacy 10 HBAR registry minimum", () => {
    expect(registrationStake(1_000_000_000n, 296)).toBe(10n * 10n ** 18n);
    expect(registryValueWei(1_000_000_000n, 296)).toBe(10n * 10n ** 18n);
  });
  it("keeps ordinary EVM values in wei", () => {
    expect(registrationStake(12n * 10n ** 18n, 31337)).toBe(12n * 10n ** 18n);
  });
  it("uses a larger live minimum without a hardcoded ceiling", () => {
    expect(registrationStake(2_000_000_000n, 296)).toBe(20n * 10n ** 18n);
  });
  it("preserves fractional stakes and rejects a request below the live minimum", () => {
    expect(registrationStake(1_000_000_000n, 296, "10.5")).toBe(105n * 10n ** 17n);
    expect(() => registrationStake(1_000_000_000n, 296, "5")).toThrow("at least 10 HBAR");
    expect(() => registrationStake(1n, 296, "NaN")).toThrow("positive HBAR amount");
  });
  it("decodes the reported selector into a useful stake message", () => {
    const abi = parseAbi(["error InsufficientStake(uint256 sent, uint256 required)"]);
    const data = encodeErrorResult({ abi, errorName: "InsufficientStake", args: [500_000_000n, 1_000_000_000n] });
    expect(data.slice(0, 10)).toBe("0x45be0a26");
    const error = new ContractFunctionRevertedError({ abi, data, functionName: "register" });
    expect(registrationError(error, 296)).toBe("Registration needs 10 HBAR of stake; the transaction supplied 5 HBAR.");
  });
});
