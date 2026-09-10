import { expect, it } from "vitest";
import { hostFunding } from "./host-funding";

it("still honors the legacy Hedera stake minimum", () => {
  expect(hostFunding(BigInt(1e9), 296)).toEqual({ stakeHbar: "10", totalHbar: "11" });
});

it("follows changes to the registry minimum and larger CLI stake choices", () => {
  expect(hostFunding(BigInt(2e9), 296, "5")).toEqual({ stakeHbar: "20", totalHbar: "21" });
  expect(hostFunding(BigInt(1e9), 296, "10.5")).toEqual({ stakeHbar: "10.5", totalHbar: "11.5" });
});

it("keeps ordinary EVM contract values in wei", () => {
  expect(hostFunding(BigInt(12) * BigInt(1e18), 31337)).toEqual({ stakeHbar: "12", totalHbar: "13" });
});

it("needs only 5 HBAR overall on the new registry", () => {
  expect(hostFunding(BigInt(4e8), 296)).toEqual({ stakeHbar: "4", totalHbar: "5" });
});
