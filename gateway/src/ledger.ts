import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createPublicClient, http, keccak256, recoverMessageAddress, toBytes, type Hex } from "viem";

// Server-issued challenges for Ledger enrollment and Ledger-protected changes.
// The gateway builds the exact message and authenticates it with an HMAC, so a
// client can only return a message this gateway issued. The message binds the
// action, the agent, the current enrollment or policy revision, a nonce, and an
// expiry; a revision that advanced after use makes every signature single-use.

export class LedgerChallengeError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
  }
}

export const CHALLENGE_TTL_MS = 5 * 60_000;

// Terminal approvals. Ledger's wallet CLI cannot sign a message, but `wallet-cli send` sends a
// transaction the device confirms. The owner sends one from the enrolled address to itself on
// Sepolia, carrying a code bound to the exact approval message; the gateway reads it back from chain.
const APPROVAL_TX_TAG = "544f5261"; // "TORa"

/// @notice Calldata for a terminal approval: a fixed tag plus keccak256 of the exact approval message.
export function ledgerTransactionData(message: string): Hex {
  return `0x${APPROVAL_TX_TAG}${keccak256(toBytes(message)).slice(2)}`;
}

export interface LedgerTransaction {
  from: string;
  to: string | null;
  input: Hex;
  chainId: number | null;
  status: "success" | "reverted" | null; // null = not mined yet
}

export interface LedgerTxChain {
  network: string; // wallet-cli network id
  chainId: number;
  transaction(hash: Hex): Promise<LedgerTransaction | null>;
}

/// @notice Ethereum Sepolia reader for terminal approvals; LEDGER_TX_RPC_URL overrides the public RPC.
export function sepoliaLedgerTxChain(rpcUrl = process.env.LEDGER_TX_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"): LedgerTxChain {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) });
  return {
    network: "ethereum:sepolia",
    chainId: 11_155_111,
    async transaction(hash) {
      const tx = await client.getTransaction({ hash }).catch((e: { name?: string }) => {
        if (e?.name === "TransactionNotFoundError") return null;
        throw e;
      });
      if (!tx) return null;
      const receipt = tx.blockNumber === null ? null : await client.getTransactionReceipt({ hash }).catch(() => null);
      return { from: tx.from, to: tx.to ?? null, input: tx.input, chainId: tx.chainId ?? null, status: receipt ? receipt.status : null };
    },
  };
}

/// @notice Deterministic JSON (sorted keys) for binding structured terms into messages.
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// Stable across restarts when an operator token exists; otherwise per process.
const challengeKey = process.env.GATEWAY_ADMIN_TOKEN
  ? createHash("sha256").update(`tor-ledger-challenge|${process.env.GATEWAY_ADMIN_TOKEN}`).digest()
  : randomBytes(32);

const mac = (message: string) => createHmac("sha256", challengeKey).update(message).digest("hex");

export function issueChallenge(lines: string[], now = Date.now(), ttlMs = CHALLENGE_TTL_MS): { message: string; token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const message = [...lines, `nonce: ${randomBytes(12).toString("hex")}`, `expires: ${expiresAt}`].join("\n");
  return { message, token: mac(message), expiresAt };
}

/// @notice Value of a "name: value" line in a challenge message.
export function challengeField(message: string, name: string): string | null {
  for (const line of message.split("\n")) if (line.startsWith(`${name}: `)) return line.slice(name.length + 2);
  return null;
}

export function verifyChallenge(message: unknown, token: unknown, now = Date.now()): string {
  if (typeof message !== "string" || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    throw new LedgerChallengeError(400, "invalid_request", "A gateway challenge and its token are required.");
  }
  const expected = Buffer.from(mac(message), "hex");
  const presented = Buffer.from(token, "hex");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    throw new LedgerChallengeError(400, "unknown_challenge", "This challenge was not issued by the gateway.");
  }
  const expires = Number(challengeField(message, "expires"));
  if (!Number.isFinite(expires) || now > expires) throw new LedgerChallengeError(409, "challenge_expired", "The challenge expired. Start again.");
  return message;
}

export async function messageSigner(message: string, signature: unknown): Promise<string> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new LedgerChallengeError(400, "invalid_request", "A 65-byte signature is required.");
  }
  try {
    return (await recoverMessageAddress({ message, signature: signature as Hex })).toLowerCase();
  } catch {
    throw new LedgerChallengeError(401, "bad_signature", "The signature is invalid.");
  }
}
