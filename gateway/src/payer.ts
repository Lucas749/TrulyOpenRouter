import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { PrivateKey } from "@hiero-ledger/sdk";
import type { Pool } from "pg";
import { db } from "./db.js";
import { X402PaymentRefused } from "./upstream.js";

export const X402_NETWORK = "hedera:testnet";
export const X402_TEST_USDC = "0.0.429274";
/// @notice Per-payment bound in test USDC units (6 decimals). Hosts ask $0.001 = 1000 units.
export const DEFAULT_MAX_PAYMENT_UNITS = 10_000n;

export interface PayerOptions {
  accountId: string;
  privateKey: string; // hex ECDSA, testnet only in this repo
  network?: "hedera:testnet";
}

/// @notice Hedera account facts the payer checks before signing.
export interface HederaAccounts {
  evmAddress(accountId: string): Promise<string | null>;
  tokenBalance(accountId: string, tokenId: string): Promise<bigint | null>;
}

/// @notice Global treasury ceilings, counted when a payment is about to be signed.
export interface PaymentCeiling {
  claim(units: bigint, now?: number): Promise<boolean>;
}

export interface PaymentBounds {
  payee?: string; // registered host EVM address; the requested payTo account must carry it
  maxAmount?: bigint; // test USDC units per payment
  ceiling?: PaymentCeiling;
  accounts?: HederaAccounts;
  transport?: typeof fetch;
}

interface Requirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra?: Record<string, unknown>;
}

/// @notice Why a host's payment requirement must not be signed, or null when it fits the bounds.
export function paymentRequirementProblem(r: Requirement, expected: { network: string; asset: string; maxAmount: bigint; payer: string }): string | null {
  if (r.scheme !== "exact") return `unsupported scheme ${r.scheme}`;
  if (r.network !== expected.network) return `network ${r.network} is not ${expected.network}`;
  if (r.asset !== expected.asset) return `asset ${r.asset} is not test USDC ${expected.asset}`;
  if (!/^[1-9]\d*$/.test(String(r.amount))) return "amount is not a positive whole number of units";
  if (BigInt(r.amount) > expected.maxAmount) return `amount ${r.amount} exceeds the ${expected.maxAmount}-unit payment bound`;
  const feePayer = r.extra?.feePayer;
  if (typeof feePayer !== "string" || !/^0\.0\.[1-9]\d*$/.test(feePayer)) return "no facilitator pays the network fee";
  if (feePayer === expected.payer) return "the network fee would be charged to the payment account";
  if (!/^0\.0\.[1-9]\d*$/.test(String(r.payTo)) || r.payTo === expected.payer) return "the payee is not a host account";
  return null;
}

/// @notice Mirror node lookups. Account aliases never change, so they are cached.
export function mirrorAccounts(base = "https://testnet.mirrornode.hedera.com", fetcher: typeof fetch = fetch): HederaAccounts {
  const aliases = new Map<string, string>();
  return {
    async evmAddress(accountId) {
      const cached = aliases.get(accountId);
      if (cached) return cached;
      const r = await fetcher(`${base}/api/v1/accounts/${encodeURIComponent(accountId)}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const body = (await r.json()) as { account?: string; evm_address?: string };
      if (body.account !== accountId || !/^0x[0-9a-fA-F]{40}$/.test(body.evm_address ?? "")) return null;
      if (aliases.size >= 5000) aliases.clear();
      aliases.set(accountId, body.evm_address!.toLowerCase());
      return body.evm_address!.toLowerCase();
    },
    async tokenBalance(accountId, tokenId) {
      const r = await fetcher(`${base}/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?token.id=${encodeURIComponent(tokenId)}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const body = (await r.json()) as { tokens?: Array<{ token_id: string; balance: number | string }> };
      const row = body.tokens?.find((t) => t.token_id === tokenId);
      return row ? BigInt(row.balance) : 0n;
    },
  };
}

/// @notice Daily treasury ceilings on host payments, shared by every gateway process.
export class PgX402Ceiling implements PaymentCeiling {
  constructor(private limits: { dailyUnits: bigint; dailyPayments: number }, private pool: Pool = db()) {}

  async claim(units: bigint, now = Date.now()): Promise<boolean> {
    const day = `d:${new Date(now).toISOString().slice(0, 10)}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO usage_counters (subject, period) VALUES ('x402:treasury:units', $1), ('x402:treasury:payments', $1) ON CONFLICT DO NOTHING`, [day]);
      const { rows } = await client.query(
        `SELECT subject, spent FROM usage_counters WHERE period = $1 AND subject IN ('x402:treasury:units', 'x402:treasury:payments') ORDER BY subject FOR UPDATE`,
        [day],
      );
      const spent = Object.fromEntries(rows.map((r) => [r.subject, BigInt(r.spent)]));
      if (spent["x402:treasury:units"] + units > this.limits.dailyUnits || spent["x402:treasury:payments"] + 1n > BigInt(this.limits.dailyPayments)) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE usage_counters SET spent = spent + CASE subject WHEN 'x402:treasury:units' THEN $2::bigint ELSE 1 END
          WHERE period = $1 AND subject IN ('x402:treasury:units', 'x402:treasury:payments')`,
        [day, units.toString()],
      );
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

/// @notice Paid fetch: 402 → validate the host's terms → sign Hedera TransferTransaction → retry → settled.
/// A 402 does not authorize arbitrary payment: network, asset, amount, fee payer, and payee
/// must fit the bounds, the treasury must hold the amount, and the global ceilings must allow it.
/// Keys live in env (dev) or Key Ring (hosts/prod) — never in code or logs.
export function createPaidFetch(opts: PayerOptions, bounds: PaymentBounds = {}): typeof fetch {
  const network = opts.network ?? X402_NETWORK;
  const signer = createClientHederaSigner(opts.accountId, PrivateKey.fromStringECDSA(opts.privateKey), { network });
  const client = new x402Client().register(network, new ExactHederaScheme(signer));
  const expected = { network, asset: X402_TEST_USDC, payer: opts.accountId, maxAmount: bounds.maxAmount ?? BigInt(process.env.X402_MAX_PAYMENT_UNITS ?? DEFAULT_MAX_PAYMENT_UNITS) };
  const accounts = bounds.accounts ?? mirrorAccounts();
  let refusal: X402PaymentRefused | null = null;
  const refuse = (type: string, message: string, hostFault: boolean) => {
    refusal = new X402PaymentRefused(503, type, message, false, hostFault);
    return { abort: true as const, reason: message };
  };

  // The policy below allows one asset under an atomic cap, narrower than the library's
  // default spend controls, and reports refusals as X402PaymentRefused.
  client.setSpendControls(false);
  client.registerPolicy((_version, requirements) => {
    const offered = requirements as unknown as Requirement[];
    const fitting = offered.filter((r) => paymentRequirementProblem(r, expected) === null);
    if (!fitting.length) {
      refuse("host_payment_refused", `The host's payment terms were refused: ${offered[0] ? paymentRequirementProblem(offered[0], expected) : "no payment option"}.`, true);
    }
    return fitting as unknown as typeof requirements;
  });

  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const r = selectedRequirements as unknown as Requirement;
    if (bounds.payee) {
      const alias = await accounts.evmAddress(r.payTo).catch(() => null);
      if (alias === null) return refuse("host_payment_unverified", "The host's payee account could not be verified. Try again shortly.", false);
      if (alias !== bounds.payee.toLowerCase()) return refuse("host_payment_refused", "The host asked to be paid at an account other than its registered one.", true);
    }
    const balance = await accounts.tokenBalance(opts.accountId, r.asset).catch(() => null);
    if (balance !== null && balance < BigInt(r.amount)) {
      return refuse("service_funding_unavailable", "The network's host payment account is out of test USDC. Your balance was not charged; try again later.", false);
    }
    // Counted before signing; a payment that then fails still counts, which only errs toward stopping early.
    if (bounds.ceiling && !(await bounds.ceiling.claim(BigInt(r.amount)))) {
      return refuse("service_payment_ceiling", "The network reached its daily host payment ceiling. Your balance was not charged; try again later.", false);
    }
  });

  const paid = wrapFetchWithPayment(bounds.transport ?? fetch, client);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    refusal = null;
    try {
      return await paid(input, init);
    } catch (e) {
      throw refusal ?? e;
    }
  }) as typeof fetch;
}
