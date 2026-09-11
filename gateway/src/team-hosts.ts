import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createPublicClient, decodeEventLog, http, parseAbi, type Hex } from "viem";
import { db } from "./db.js";

// Team host earnings. A team owner opens a one-time link; the host operator signs its
// exact terms with the registered host key, binding team, network, registry,
// destination wallet, nonce, and expiry. Hosts collect on their own machine: HBAR
// leaves the vault through withdraw() to the host, then the host transfers it to the
// team wallet; test USDC moves directly. The gateway records a leg only after checking
// its receipt on chain, so a missing second leg stays pending with the withdrawal
// receipt kept and is never counted as received.

export const HOST_LINK_TTL_MS = 30 * 60_000;
export const TEST_USDC_FACADE = "0x0000000000000000000000000000000000068cda";
const EVENTS = parseAbi([
  "event Withdrawn(address indexed host, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export class TeamHostError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(message);
  }
}

export interface HostLink {
  code: string;
  orgId: string;
  teamName: string;
  destination: string;
  hostAddress: string | null;
  registry: string | null;
  state: "pending" | "active" | "revoked";
  signature: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  linkedAt: number | null;
}

export interface Collection {
  id: string;
  orgId: string;
  hostAddress: string;
  asset: "hbar" | "usdc";
  state: "pending" | "received";
  withdrawTx: string | null;
  withdrawnTinybar: string | null;
  transferTx: string | null;
  receivedAmount: string | null; // weibar for HBAR, units for test USDC
  createdAt: number;
  updatedAt: number;
}

/// @notice The exact terms a host key signs to send its collected earnings to a team wallet.
export function hostLinkMessage(link: Pick<HostLink, "code" | "orgId" | "teamName" | "destination" | "expiresAt">, host: string, registry: string, origin: string): string {
  return [
    "TrulyOpenRouter host link",
    `origin: ${origin}`,
    "network: hedera-testnet (chain 296)",
    `registry: ${registry.toLowerCase()}`,
    `host: ${host.toLowerCase()}`,
    `team: ${link.teamName} (${link.orgId})`,
    `destination: ${link.destination.toLowerCase()}`,
    "action: collect this host's earnings only into the destination wallet",
    `nonce: ${link.code}`,
    `expires: ${new Date(link.expiresAt).toISOString()}`,
  ].join("\n");
}

const num = (v: unknown) => (v == null ? null : Number(v));
function rowToLink(r: any): HostLink {
  return {
    code: r.code, orgId: r.org_id, teamName: r.team_name, destination: r.destination, hostAddress: r.host_address ?? null, registry: r.registry ?? null,
    state: r.state, signature: r.signature ?? null, createdBy: r.created_by, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), linkedAt: num(r.linked_at),
  };
}
function rowToCollection(r: any): Collection {
  return {
    id: r.id, orgId: r.org_id, hostAddress: r.host_address, asset: r.asset, state: r.state, withdrawTx: r.withdraw_tx ?? null, withdrawnTinybar: r.withdrawn_tinybar ?? null,
    transferTx: r.transfer_tx ?? null, receivedAmount: r.received_amount ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

export class PgTeamHosts {
  constructor(private pool: Pool = db()) {}

  async createLink(input: { orgId: string; teamName: string; destination: string; createdBy: string }, now = Date.now()): Promise<HostLink> {
    const { rows } = await this.pool.query(
      `INSERT INTO team_host_links (code, org_id, team_name, destination, state, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7) RETURNING *`,
      [`thl_${randomBytes(12).toString("base64url")}`, input.orgId, input.teamName, input.destination.toLowerCase(), input.createdBy, now, now + HOST_LINK_TTL_MS],
    );
    return rowToLink(rows[0]);
  }

  async link(code: string): Promise<HostLink | null> {
    const { rows } = await this.pool.query(`SELECT * FROM team_host_links WHERE code = $1`, [code]);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  /// @notice Activate a pending, unexpired link for one host; any earlier team link of that host ends.
  async activate(code: string, host: string, registry: string, signature: string, now = Date.now()): Promise<HostLink | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const pending = await client.query(`SELECT code FROM team_host_links WHERE code = $1 AND state = 'pending' AND expires_at > $2 FOR UPDATE`, [code, now]);
      if (!pending.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(`UPDATE team_host_links SET state = 'revoked' WHERE host_address = $1 AND state = 'active'`, [host.toLowerCase()]);
      const { rows } = await client.query(
        `UPDATE team_host_links SET state = 'active', host_address = $2, registry = $3, signature = $4, linked_at = $5 WHERE code = $1 RETURNING *`,
        [code, host.toLowerCase(), registry.toLowerCase(), signature, now],
      );
      await client.query("COMMIT");
      return rowToLink(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async activeForHost(host: string): Promise<HostLink | null> {
    const { rows } = await this.pool.query(`SELECT * FROM team_host_links WHERE host_address = $1 AND state = 'active'`, [host.toLowerCase()]);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async forOrg(orgId: string, now = Date.now()): Promise<HostLink[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM team_host_links WHERE org_id = $1 AND (state = 'active' OR (state = 'pending' AND expires_at > $2)) ORDER BY created_at DESC`,
      [orgId, now],
    );
    return rows.map(rowToLink);
  }

  async revoke(orgId: string, host: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`UPDATE team_host_links SET state = 'revoked' WHERE org_id = $1 AND host_address = $2 AND state = 'active'`, [orgId, host.toLowerCase()]);
    return (rowCount ?? 0) > 0;
  }

  async collectionByTx(hash: string): Promise<Collection | null> {
    const { rows } = await this.pool.query(`SELECT * FROM host_collections WHERE withdraw_tx = $1 OR transfer_tx = $1`, [hash.toLowerCase()]);
    return rows[0] ? rowToCollection(rows[0]) : null;
  }

  async insertCollection(c: Omit<Collection, "id" | "createdAt" | "updatedAt">, now = Date.now()): Promise<Collection> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO host_collections (id, org_id, host_address, asset, state, withdraw_tx, withdrawn_tinybar, transfer_tx, received_amount, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *`,
        [`col_${randomUUID()}`, c.orgId, c.hostAddress.toLowerCase(), c.asset, c.state, c.withdrawTx, c.withdrawnTinybar, c.transferTx, c.receivedAmount, now],
      );
      return rowToCollection(rows[0]);
    } catch (e: any) {
      if (e?.code === "23505") throw new TeamHostError(409, "already_recorded", "That transaction is already recorded for a collection.");
      throw e;
    }
  }

  /// @notice Attach the confirmed team transfer to a pending HBAR collection, once.
  async completeCollection(id: string, transferTx: string, receivedAmount: string, now = Date.now()): Promise<Collection | null> {
    try {
      const { rows } = await this.pool.query(
        `UPDATE host_collections SET state = 'received', transfer_tx = $2, received_amount = $3, updated_at = $4 WHERE id = $1 AND state = 'pending' RETURNING *`,
        [id, transferTx.toLowerCase(), receivedAmount, now],
      );
      return rows[0] ? rowToCollection(rows[0]) : null;
    } catch (e: any) {
      if (e?.code === "23505") throw new TeamHostError(409, "already_recorded", "That transfer is already recorded for another collection.");
      throw e;
    }
  }

  /// @notice Collection sums across all of a team's records: pending withdrawals and received amounts.
  async totals(orgId: string): Promise<{ pendingTinybar: string; receivedWei: string; receivedUsdcUnits: string }> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(withdrawn_tinybar::numeric) FILTER (WHERE state = 'pending'), 0)::text AS pending_tinybar,
              COALESCE(SUM(received_amount::numeric) FILTER (WHERE state = 'received' AND asset = 'hbar'), 0)::text AS received_wei,
              COALESCE(SUM(received_amount::numeric) FILTER (WHERE state = 'received' AND asset = 'usdc'), 0)::text AS received_usdc
         FROM host_collections WHERE org_id = $1`,
      [orgId],
    );
    return { pendingTinybar: rows[0].pending_tinybar, receivedWei: rows[0].received_wei, receivedUsdcUnits: rows[0].received_usdc };
  }

  async collections(orgId: string, limit = 50): Promise<Collection[]> {
    const { rows } = await this.pool.query(`SELECT * FROM host_collections WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`, [orgId, limit]);
    return rows.map(rowToCollection);
  }
}

export interface ChainTx {
  from: string;
  to: string | null;
  value: bigint;
  status: "success" | "reverted";
  logs: Array<{ address: string; topics: Hex[]; data: Hex }>;
}

export interface CollectionChain {
  transaction(hash: Hex): Promise<ChainTx | null>;
}

export function hederaCollectionChain(rpcUrl: string): CollectionChain {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15000, retryCount: 1 }) });
  return {
    async transaction(hash) {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (!receipt) return null;
      const tx = await client.getTransaction({ hash });
      return { from: tx.from, to: tx.to ?? null, value: tx.value, status: receipt.status, logs: receipt.logs as ChainTx["logs"] };
    },
  };
}

export interface TeamHostDeps {
  store: Pick<PgTeamHosts, "activeForHost" | "collectionByTx" | "insertCollection" | "completeCollection">;
  chain: CollectionChain;
  vault: string;
}

function eventTotal(logs: ChainTx["logs"], emitter: string, match: (e: { eventName: string; args: any }) => bigint): bigint {
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== emitter.toLowerCase()) continue;
    try {
      total += match(decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as { eventName: string; args: any });
    } catch {
      // Unrelated events from the same emitter are ignored.
    }
  }
  return total;
}

const txHash = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v.toLowerCase() as Hex) : null);

/// @notice Record a collection leg for a linked host after verifying it on chain.
export async function recordCollection(d: TeamHostDeps, hostAddress: string, input: { asset?: unknown; withdrawTx?: unknown; transferTx?: unknown }, now = Date.now()): Promise<Collection> {
  const host = hostAddress.toLowerCase();
  const link = await d.store.activeForHost(host);
  if (!link) throw new TeamHostError(404, "not_linked", "This host is not linked to a team.");
  const confirmed = async (hash: Hex, label: string) => {
    const tx = await d.chain.transaction(hash);
    if (!tx) throw new TeamHostError(409, "not_confirmed", `The ${label} has no receipt yet. Retry after it confirms.`);
    if (tx.status !== "success") throw new TeamHostError(409, "reverted", `The ${label} reverted.`);
    if (tx.from.toLowerCase() !== host) throw new TeamHostError(403, "wrong_sender", `The ${label} was not sent by this host.`);
    return tx;
  };

  if (input.asset === "usdc") {
    const transferTx = txHash(input.transferTx);
    if (!transferTx) throw new TeamHostError(400, "invalid_request", "transferTx is required.");
    const tx = await confirmed(transferTx, "test USDC transfer");
    const moved = eventTotal(tx.logs, TEST_USDC_FACADE, (e) =>
      e.eventName === "Transfer" && e.args.from.toLowerCase() === host && e.args.to.toLowerCase() === link.destination ? e.args.value : 0n);
    if (moved === 0n) throw new TeamHostError(409, "wrong_destination", "The transaction did not move test USDC from this host to the team wallet.");
    return d.store.insertCollection({ orgId: link.orgId, hostAddress: host, asset: "usdc", state: "received", withdrawTx: null, withdrawnTinybar: null, transferTx, receivedAmount: String(moved) }, now);
  }
  if (input.asset !== "hbar") throw new TeamHostError(400, "invalid_request", "asset must be hbar or usdc.");

  const withdrawTx = txHash(input.withdrawTx);
  if (!withdrawTx) throw new TeamHostError(400, "invalid_request", "withdrawTx is required for HBAR collection.");
  let collection = await d.store.collectionByTx(withdrawTx);
  if (!collection) {
    const withdrawal = await confirmed(withdrawTx, "vault withdrawal");
    const withdrawn = eventTotal(withdrawal.logs, d.vault, (e) => (e.eventName === "Withdrawn" && e.args.host.toLowerCase() === host ? e.args.amount : 0n));
    if (withdrawal.to?.toLowerCase() !== d.vault.toLowerCase() || withdrawn === 0n) {
      throw new TeamHostError(409, "not_a_withdrawal", "The transaction is not a vault earnings withdrawal by this host.");
    }
    collection = await d.store.insertCollection({ orgId: link.orgId, hostAddress: host, asset: "hbar", state: "pending", withdrawTx, withdrawnTinybar: String(withdrawn), transferTx: null, receivedAmount: null }, now);
  }
  if (collection.hostAddress !== host || collection.withdrawTx !== withdrawTx) throw new TeamHostError(409, "already_recorded", "That transaction belongs to another collection.");
  const transferTx = txHash(input.transferTx);
  if (!transferTx || collection.state === "received") return collection;
  if (collection.orgId !== link.orgId) throw new TeamHostError(409, "team_changed", "This withdrawal was recorded for a different team link.");
  const transfer = await confirmed(transferTx, "team transfer");
  if (transfer.to?.toLowerCase() !== link.destination || transfer.value === 0n) {
    throw new TeamHostError(409, "wrong_destination", "The transaction did not send HBAR from this host to the team wallet.");
  }
  return (await d.store.completeCollection(collection.id, transferTx, String(transfer.value), now)) ?? collection;
}
