import type { Pool } from "pg";

export const FAUCET_HBAR = 5;
const DAY = 24 * 60 * 60 * 1000;

export class FaucetError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface FaucetGrant {
  address: string;
  user_id: string;
  created_at: number;
  transaction_id: string;
  signed_transaction: string;
  status: "pending" | "sent" | "failed";
}

export interface FaucetSender {
  accountId: string;
  address: string;
  balanceTinybar(): Promise<bigint>;
  prepare(address: string): Promise<{ transactionId: string; bytes: string }>;
  settle(grant: FaucetGrant): Promise<FaucetGrant["status"]>;
}

export type FaucetResult = { status: FaucetGrant["status"]; amountHbar: number; transactionId: string };
export interface HostFaucet {
  claim(address: string, userId: string): Promise<FaucetResult>;
}

// A database lock serializes reservations across gateway instances. Commit the
// signed transaction BEFORE broadcasting; retries always submit those same bytes.
export class PgHostFaucet implements HostFaucet {
  constructor(
    private pool: Pool,
    private sender: FaucetSender,
    private ownerOf: (address: string) => Promise<string | null>,
    private dailyGrants = 10,
  ) {
    if (!Number.isSafeInteger(dailyGrants) || dailyGrants < 1) throw new Error("FAUCET_DAILY_GRANTS must be a positive integer");
  }

  async claim(input: string, userId: string): Promise<FaucetResult> {
    const address = input.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address) || address === this.sender.address.toLowerCase()) {
      throw new FaucetError(400, "invalid_address", "Enter a valid host address.");
    }
    if (!userId.startsWith("did:privy:") || userId.length > 200) throw new FaucetError(401, "unauthorized", "Sign in to get test HBAR.");
    if (await this.ownerOf(address) !== userId) throw new FaucetError(403, "host_not_linked", "Link this host to your account from the terminal first.");

    const conn = await this.pool.connect();
    let grant: FaucetGrant;
    try {
      await conn.query("BEGIN");
      await conn.query("SELECT pg_advisory_xact_lock(73405129)");
      const existing = await conn.query<FaucetGrant>("SELECT * FROM host_faucet_grants WHERE address=$1", [address]);
      if (existing.rows[0]) {
        grant = existing.rows[0];
        if (grant.user_id !== userId) throw new FaucetError(409, "already_claimed", "This host has already received its funding grant.");
      } else {
        const recent = await conn.query<{ user_count: string; total: string; pending: string }>(
          `SELECT count(*) FILTER (WHERE user_id=$1 AND created_at>$2) AS user_count,
            count(*) FILTER (WHERE created_at>$2) AS total,
            count(*) FILTER (WHERE status='pending') AS pending FROM host_faucet_grants`,
          [userId, Date.now() - DAY],
        );
        const counts = recent.rows[0];
        if (Number(counts.user_count) >= 1) throw new FaucetError(429, "account_limit", "You can fund one host every 24 hours. The Hedera faucet is also available.");
        if (Number(counts.total) >= this.dailyGrants) throw new FaucetError(429, "daily_limit", "Today's funding allowance is used up. Try again later or use the Hedera faucet.");
        // Reserve 5 HBAR plus a 1 HBAR maximum network fee for every pending grant.
        if (await this.sender.balanceTinybar() < BigInt(Number(counts.pending) + 1) * 600_000_000n) {
          throw new FaucetError(503, "faucet_empty", "Our test HBAR pool needs a refill. Please use the Hedera faucet for now.");
        }
        const prepared = await this.sender.prepare(address);
        grant = { address, user_id: userId, created_at: Date.now(), status: "pending", transaction_id: prepared.transactionId, signed_transaction: prepared.bytes };
        await conn.query(
          `INSERT INTO host_faucet_grants(address,user_id,created_at,transaction_id,signed_transaction,status)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [grant.address, grant.user_id, grant.created_at, grant.transaction_id, grant.signed_transaction, grant.status],
        );
      }
      await conn.query("COMMIT");
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    } finally { conn.release(); }

    if (grant.status === "pending") {
      // An uncertain response stays pending, preserving the reservation and ID.
      const status = await this.sender.settle(grant).catch(() => "pending" as const);
      if (status !== "pending") {
        await this.pool.query("UPDATE host_faucet_grants SET status=$2 WHERE address=$1 AND status='pending'", [address, status]);
      }
      const current = await this.pool.query<FaucetGrant>("SELECT * FROM host_faucet_grants WHERE address=$1", [address]);
      grant = current.rows[0];
    }
    return { status: grant.status, amountHbar: FAUCET_HBAR, transactionId: grant.transaction_id };
  }
}
