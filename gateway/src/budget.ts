import { createHash } from "crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

// Per-key Hedera budget accounts, derived deterministically so no per-user storage is needed:
//   budgetKey = HKDF-SHA256(master, "tor-budget-v1" || prefix || counter) mod n
// Only the single master lives in env (dev) or Key Ring (prod). Funding is an operator step:
// freshly derived accounts start empty — the funder tops them from the vault/treasury.
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function hkdf(master: Buffer, info: string): Buffer {
  // Minimal HKDF-SHA256 (extract with zero salt, single expand block — 32 bytes out).
  const prk = createHash("sha256").update(Buffer.alloc(32)).update(master).digest();
  return createHash("sha256").update(prk).update(Buffer.from(info)).update(Buffer.from([1])).digest();
}

export function deriveBudgetKey(masterHex: Hex, prefix: string): Hex {
  const master = Buffer.from(masterHex.replace(/^0x/, ""), "hex");
  if (master.length !== 32) throw new Error("budget master must be 32 bytes");
  for (let counter = 0; counter < 256; counter++) {
    const candidate = BigInt("0x" + hkdf(master, `tor-budget-v1|${prefix}|${counter}`).toString("hex"));
    if (candidate > 0n && candidate < SECP256K1_N) {
      return ("0x" + candidate.toString(16).padStart(64, "0")) as Hex;
    }
  }
  throw new Error("budget derivation failed");
}

export function deriveBudgetAddress(masterHex: Hex, prefix: string): `0x${string}` {
  return privateKeyToAccount(deriveBudgetKey(masterHex, prefix)).address;
}

/// @notice Resolve a key prefix to its budget account on demand. Derivation is
/// deterministic from the single master, so NO mapping is stored anywhere —
/// nothing to persist, nothing to lose on restart. Null when no master.
export function budgetAddressFor(prefix: string | undefined, master = process.env.BUDGET_MASTER): string | null {
  if (!prefix || !master) return null;
  try {
    return deriveBudgetAddress(master as `0x${string}`, prefix);
  } catch {
    return null;
  }
}
