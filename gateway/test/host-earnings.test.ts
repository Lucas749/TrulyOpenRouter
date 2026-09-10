import { expect, it } from "vitest";
import { hostEarnings } from "../src/host-earnings.js";

it("converts vault credits using its payout rate, including nonzero earnings", async () => {
  const address = `0x${"1".repeat(40)}` as const;
  const reader = { readContract: async ({ functionName }: { functionName: string }) => functionName === "hostEarnings" ? 900n : 100000n } as any;
  expect(await hostEarnings(reader, address, address)).toEqual({ credits: "900", tinybar: "90000000", rate: 100000n });
});
