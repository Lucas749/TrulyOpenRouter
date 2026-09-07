import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { sha256hex } from "./receipts.js";

// PENDING_TAP queue (L4: device-gated execution) — HEDERA ONLY.
//
// High-risk server actions (stake release, heartbeat-as-host, …) NEVER execute
// directly. They queue as PENDING_TAP; the operator approves with their LEDGER
// by sending an exact dust amount of HBAR to THEMSELF on Hedera (testnet =
// faucet money, Ledger Live HBAR app, no other network involved). The backend
// verifies the self-transfer on the public mirror node (sender == receiver ==
// recorded Ledger account, exact amount, inside the tap window, optional memo
// match) and only then executes the Hedera call with the ring-held host key.
// Proof chain: approval transfer → execution tx, both HashScan-linkable, both
// on the tap record. No trusted clicks anywhere.
//
// Why amount-binding, not memo: Ledger Live's HBAR send may not expose a memo
// field; an exact dust amount to self always works and is unambiguous.

export type TapKind = "heartbeat" | "stake-release";
export type TapStatus = "pending" | "approved" | "executed" | "failed";

export interface Tap {
  id: string;
  kind: TapKind;
  params: Record<string, string>;
  actionHash: string;
  approveMemo: string; // recorded intent; matched opportunistically, not required
  approveAmountTinybar: number; // exact dust the Ledger must send to itself
  status: TapStatus;
  createdAt: number;
  tapTx?: string; // Hedera approval transfer id (e.g. 0.0.x@sec.nanos)
  tapSigner?: string; // verified sender account
  execTx?: string; // Hedera execution tx hash
  execError?: string;
}

const KINDS: TapKind[] = ["heartbeat", "stake-release"];

/// @notice Deterministic dust per tap: 10000 + hash slice, i.e. 0.0001–0.00019
/// HBAR. Unique per tap id, unguessable, unambiguous on the mirror node.
export function approveAmountTinybar(id: string): number {
  const h = sha256hex(`tor-tap:${id}`);
  return 10000 + (parseInt(h.slice(0, 8), 16) % 9000);
}

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
    const tap: Tap = {
      id,
      kind: kind as TapKind,
      params,
      actionHash: hash,
      approveMemo: tapMemo(id, hash),
      approveAmountTinybar: approveAmountTinybar(id),
      status: "pending",
      createdAt: Date.now(),
    };
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

export function formatHbar(tinybar: number): string {
  return (tinybar / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0");
}

interface MirrorRpc {
  fetchFn?: typeof fetch;
  url?: string;
}

async function mirrorGet(mirror: Required<MirrorRpc>, path: string): Promise<any> {
  const res = await mirror.fetchFn(`${mirror.url}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`mirror ${res.status} on ${path}`);
  return res.json();
}

/// @notice Verify a tap approval on the Hedera mirror node: a cryptotransfer
/// AFTER the tap was queued where sender == receiver == the recorded Ledger
/// account AND the exact dust amount moved. Memo match is a bonus signal, not
/// required (Ledger Live may not expose memo). Returns the transaction id.
export async function verifyTapTransfer(tap: Tap, ledgerAccount: string, mirror: MirrorRpc = {}): Promise<string> {
  if (tap.status !== "pending") throw new Error(`tap already ${tap.status}`);
  const full: Required<MirrorRpc> = {
    fetchFn: mirror.fetchFn ?? fetch,
    url: mirror.url ?? process.env.MIRROR_URL ?? "https://testnet.mirrornode.hedera.com",
  };
  const createdSec = Math.floor(tap.createdAt / 1000) - 30; // clock skew grace
  const data: any = await mirrorGet(full, `/api/v1/transactions?account.id=${ledgerAccount}&transactiontype=cryptotransfer&limit=25&order=desc`);
  for (const tx of data?.transactions ?? []) {
    if (Number(String(tx.consensus_timestamp ?? "0").split(".")[0]) < createdSec) continue;
    const transfers: any[] = tx?.transfers ?? [];
    // Self-transfer of exactly the dust amount: sender==receiver==ledger account.
    const self = transfers.filter((t) => t.account === ledgerAccount);
    if (self.length === 0) continue;
    const net = self.reduce((sum, t) => sum + Number(t.amount ?? 0), 0);
    if (net !== 0) continue; // must net to zero = to self
    const moved = self.reduce((sum, t) => sum + Math.abs(Number(t.amount ?? 0)), 0) / 2;
    if (moved !== tap.approveAmountTinybar) continue;
    return String(tx.transaction_id);
  }
  throw new Error("no matching Ledger approval found (send the exact HBAR amount to yourself, then retry)");
}

/// @notice The exact instruction the UI shows per tap. One network, testnet
/// faucet money, Ledger Live HBAR app.
export function tapInstruction(tap: Tap, ledgerAccount: string): string {
  return `In Ledger Live (HBAR app): send exactly ${formatHbar(tap.approveAmountTinybar)} HBAR from ${ledgerAccount} to ${ledgerAccount} (yourself), then come back and hit Verify`;
}

