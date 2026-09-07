import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { sha256hex } from "./receipts.js";

// PENDING_TAP queue (L4: device-gated execution).
//
// High-risk server actions (stake release, heartbeat-as-host, …) NEVER execute
// directly. They queue as PENDING_TAP; the operator approves on the Ledger by
// sending a dust Solana memo tx (fractions of a cent, device reviews memo +
// amount). The backend verifies the memo onchain (fee payer == recorded Ledger
// Solana address, memo == expected) and only then executes the Hedera call with
// the ring-held host key. Proof chain: Solana txSig → Hedera txHash, both on
// the tap record. No trusted clicks anywhere.

export type TapKind = "heartbeat" | "stake-release";
export type TapStatus = "pending" | "approved" | "executed" | "failed";

export interface Tap {
  id: string;
  kind: TapKind;
  params: Record<string, string>;
  actionHash: string;
  approveMemo: string;
  status: TapStatus;
  createdAt: number;
  tapTx?: string; // Solana approval tx signature
  tapSigner?: string; // verified fee payer
  execTx?: string; // Hedera execution tx hash
  execError?: string;
}

const KINDS: TapKind[] = ["heartbeat", "stake-release"];

export function tapMemo(id: string, actionHash: string): string {
  return `tor-approve:${id}:${actionHash}`;
}

export function actionHash(kind: string, params: Record<string, string>): string {
  const canon = [kind, ...Object.keys(params).sort().map((k) => `${k}=${params[k]}`)].join("|");
  return `0x${sha256hex(canon)}`;
}

interface TapFile {
  taps: Record<string, Tap>;
}

export class TapStore {
  private file: string;

  constructor(dir?: string) {
    const d = dir ?? process.env.TAPS_DIR ?? join(process.cwd(), ".data");
    mkdirSync(d, { recursive: true });
    this.file = join(d, "taps.json");
  }

  private read(): TapFile {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as TapFile;
    } catch {
      return { taps: {} };
    }
  }

  private write(s: TapFile): void {
    writeFileSync(this.file, JSON.stringify(s, null, 2));
  }

  queue(kind: string, params: Record<string, string> = {}): Tap {
    if (!(KINDS as string[]).includes(kind)) throw new Error(`unknown tap kind (want ${KINDS.join("|")})`);
    for (const [k, v] of Object.entries(params)) {
      if (typeof v !== "string" || !v) throw new Error(`param ${k} must be a non-empty string`);
    }
    const s = this.read();
    const id = `tap_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    const hash = actionHash(kind, params);
    const tap: Tap = { id, kind: kind as TapKind, params, actionHash: hash, approveMemo: tapMemo(id, hash), status: "pending", createdAt: Date.now() };
    s.taps[id] = tap;
    this.write(s);
    return tap;
  }

  get(id: string): Tap | null {
    return this.read().taps[id] ?? null;
  }

  list(status?: TapStatus): Tap[] {
    return Object.values(this.read().taps)
      .filter((t) => !status || t.status === status)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  markApproved(id: string, tapTx: string, tapSigner: string): Tap {
    const s = this.read();
    const t = s.taps[id];
    if (!t) throw new Error("tap not found");
    if (t.status !== "pending") throw new Error(`tap already ${t.status}`);
    t.status = "approved";
    t.tapTx = tapTx;
    t.tapSigner = tapSigner;
    this.write(s);
    return t;
  }

  markExecuted(id: string, execTx: string): Tap {
    const s = this.read();
    const t = s.taps[id];
    if (!t) throw new Error("tap not found");
    t.status = "executed";
    t.execTx = execTx;
    this.write(s);
    return t;
  }

  markFailed(id: string, execError: string): Tap {
    const s = this.read();
    const t = s.taps[id];
    if (!t) throw new Error("tap not found");
    t.status = "failed";
    t.execError = execError.slice(0, 200);
    this.write(s);
    return t;
  }
}

interface SolanaRpc {
  fetchFn?: typeof fetch;
  url?: string;
}

async function rpcCall(rpc: Required<SolanaRpc>, method: string, params: unknown[]): Promise<any> {
  const res = await rpc.fetchFn(rpc.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const d = (await res.json()) as any;
  if (d.error) throw new Error(`solana ${method}: ${d.error.message ?? "unknown"}`);
  return d.result;
}

/// @notice Verify a tap approval: scan the authorized signer's recent Solana
/// signatures for a tx whose fee payer is the signer AND whose memo program
/// logged exactly the expected approveMemo. Returns the tx signature.
export async function verifyTapMemo(
  tap: Tap,
  authorizedSigner: string,
  rpc: SolanaRpc = {},
): Promise<string> {
  if (tap.status !== "pending") throw new Error(`tap already ${tap.status}`);
  const full: Required<SolanaRpc> = { fetchFn: rpc.fetchFn ?? fetch, url: rpc.url ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com" };
  const sigs: Array<{ signature: string }> = await rpcCall(full, "getSignaturesForAddress", [authorizedSigner, { limit: 20 }]);
  for (const { signature } of sigs ?? []) {
    const tx: any = await rpcCall(full, "getTransaction", [signature, { maxSupportedTransactionVersion: 0 }]);
    const keys: string[] = tx?.transaction?.message?.accountKeys?.map((k: any) => (typeof k === "string" ? k : k.pubkey)) ?? [];
    if (keys[0] !== authorizedSigner) continue; // fee payer must be the Ledger address
    const logs: string[] = tx?.meta?.logMessages ?? [];
    // Exact memo in quotes required — prefix games ("...:evil") don't pass.
    if (!logs.some((l) => l.includes(`"${tap.approveMemo}"`))) continue;
    return signature;
  }
  throw new Error("no matching Solana approval found (send the memo tx, then retry)");
}

/// @notice The exact device command the UI shows per tap. Amount is dust to
/// self; the memo binds tap id + action hash. Device reviews both on screen.
export function tapCommand(tap: Tap, signer: string): string {
  return `wallet-cli send solana-1 --to ${signer} --amount '0.00001 SOL' --memo '${tap.approveMemo}'`;
}
