import { expect, it, vi } from "vitest";
import { findHostRegistry } from "../src/host-registry.js";

const primary = `0x${"1".repeat(40)}` as const;
const legacy = `0x${"2".repeat(40)}` as const;
const address = `0x${"3".repeat(40)}` as const;
const empty = { active: false, stake: 0n };

it("registers fresh keys on the primary registry", async () => {
  const client = { readContract: vi.fn().mockResolvedValue(empty) };
  expect((await findHostRegistry(client, primary, [legacy], address)).registry).toBe(primary);
});

it("resumes an active legacy host without another stake", async () => {
  const client = { readContract: vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce({ active: true, stake: 1_000_000_000n }) };
  expect((await findHostRegistry(client, primary, [legacy], address)).registry).toBe(legacy);
});

it("keeps pending withdrawals on the registry holding the stake", async () => {
  const client = { readContract: vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce({ active: false, stake: 1_000_000_000n }) };
  expect((await findHostRegistry(client, primary, [legacy], address)).registry).toBe(legacy);
});

it("stops on unreadable legacy records instead of risking a second stake", async () => {
  const client = { readContract: vi.fn().mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error("RPC unavailable")) };
  await expect(findHostRegistry(client, primary, [legacy], address)).rejects.toThrow("RPC unavailable");
});
