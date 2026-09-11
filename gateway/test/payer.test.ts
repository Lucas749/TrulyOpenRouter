import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { createPaidFetch, paymentRequirementProblem, PgX402Ceiling, type HederaAccounts, type PaymentCeiling } from "../src/payer.js";
import { proxyWithFallback, X402PaymentRefused } from "../src/upstream.js";

const PAYER = "0.0.5005";
const HOST_ACCOUNT = "0.0.6006";
const HOST_EVM = `0x${"ab".repeat(20)}`;
const KEY = PrivateKey.generateECDSA().toStringRaw();
const EXPECTED = { network: "hedera:testnet", asset: "0.0.429274", maxAmount: 10_000n, payer: PAYER };

const requirement = (over: Record<string, unknown> = {}) => ({
  scheme: "exact", network: "hedera:testnet", asset: "0.0.429274", amount: "1000", payTo: HOST_ACCOUNT, maxTimeoutSeconds: 180, extra: { feePayer: "0.0.7007" }, ...over,
});

/// A host guard that asks for payment, then serves the request carrying a payment signature.
function gatedHost(accepts: Array<Record<string, unknown>>) {
  const signatures: string[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const signature = req.headers.get("PAYMENT-SIGNATURE");
    if (signature) {
      signatures.push(signature);
      return Response.json({ choices: [] });
    }
    const header = encodePaymentRequiredHeader({ x402Version: 2, error: "Payment required", resource: { url: req.url, description: "chat", mimeType: "application/json" }, accepts } as any);
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": header } });
  });
  return { transport, signatures };
}

function accounts(over: Partial<{ alias: string | null; balance: bigint | null }> = {}): HederaAccounts {
  return {
    evmAddress: async (id) => (id === HOST_ACCOUNT ? ("alias" in over ? over.alias! : HOST_EVM) : null),
    tokenBalance: async () => ("balance" in over ? over.balance! : 1_000_000n),
  };
}

const ceiling = (allow = true) => {
  const claims: bigint[] = [];
  const c: PaymentCeiling = { claim: async (units) => (claims.push(units), allow) };
  return { c, claims };
};

const call = (paid: typeof fetch) => paid("https://host.test/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

describe("host payment requirements", () => {
  it("accepts only exact test USDC on Hedera testnet within the bound, with a separate fee payer and host payee", () => {
    expect(paymentRequirementProblem(requirement(), EXPECTED)).toBeNull();
    expect(paymentRequirementProblem(requirement({ network: "hedera:mainnet" }), EXPECTED)).toMatch(/network/);
    expect(paymentRequirementProblem(requirement({ asset: "0.0.0" }), EXPECTED)).toMatch(/asset/);
    expect(paymentRequirementProblem(requirement({ scheme: "upto" }), EXPECTED)).toMatch(/scheme/);
    expect(paymentRequirementProblem(requirement({ amount: "10001" }), EXPECTED)).toMatch(/bound/);
    expect(paymentRequirementProblem(requirement({ amount: "0" }), EXPECTED)).toMatch(/positive/);
    expect(paymentRequirementProblem(requirement({ amount: "1.5" }), EXPECTED)).toMatch(/positive/);
    expect(paymentRequirementProblem(requirement({ extra: {} }), EXPECTED)).toMatch(/fee/);
    expect(paymentRequirementProblem(requirement({ extra: { feePayer: PAYER } }), EXPECTED)).toMatch(/fee/);
    expect(paymentRequirementProblem(requirement({ payTo: PAYER }), EXPECTED)).toMatch(/payee/);
  });
});

describe("paid fetch", () => {
  it("signs a transfer of exactly the requested amount to the registered host and counts it", async () => {
    const host = gatedHost([requirement()]);
    const { c, claims } = ceiling();
    const res = await call(createPaidFetch({ accountId: PAYER, privateKey: KEY }, { payee: HOST_EVM, ceiling: c, accounts: accounts(), transport: host.transport as typeof fetch }));
    expect(res.status).toBe(200);
    expect(host.signatures).toHaveLength(1);
    const payload = decodePaymentSignatureHeader(host.signatures[0]) as any;
    expect(payload.accepted).toMatchObject({ payTo: HOST_ACCOUNT, amount: "1000", asset: "0.0.429274", network: "hedera:testnet" });
    expect(typeof payload.payload.transaction).toBe("string");
    expect(claims).toEqual([1000n]);
  });

  it("picks the fitting option when a host offers several", async () => {
    const host = gatedHost([requirement({ amount: "50000" }), requirement()]);
    await call(createPaidFetch({ accountId: PAYER, privateKey: KEY }, { payee: HOST_EVM, accounts: accounts(), transport: host.transport as typeof fetch }));
    expect((decodePaymentSignatureHeader(host.signatures[0]) as any).accepted.amount).toBe("1000");
  });

  it.each([
    ["an overpriced request", [requirement({ amount: "20000" })], {}, "host_payment_refused", true],
    ["another asset", [requirement({ asset: "0.0.1234" })], {}, "host_payment_refused", true],
    ["a fee charged to the payer", [requirement({ extra: { feePayer: PAYER } })], {}, "host_payment_refused", true],
    ["a payee that is not the registered host", [requirement()], { alias: `0x${"cd".repeat(20)}` }, "host_payment_refused", true],
    ["an unverifiable payee", [requirement()], { alias: null }, "host_payment_unverified", false],
    ["a treasury without enough test USDC", [requirement()], { balance: 999n }, "service_funding_unavailable", false],
  ])("refuses %s before signing", async (_label, accepts, facts, type, hostFault) => {
    const host = gatedHost(accepts);
    const { c, claims } = ceiling();
    const refused = await call(createPaidFetch({ accountId: PAYER, privateKey: KEY }, { payee: HOST_EVM, ceiling: c, accounts: accounts(facts), transport: host.transport as typeof fetch })).catch((e) => e);
    expect(refused).toBeInstanceOf(X402PaymentRefused);
    expect(refused).toMatchObject({ status: 503, type, signed: false, hostFault });
    expect(host.signatures).toHaveLength(0);
    expect(claims).toEqual([]);
  });

  it("stops at the global ceiling without signing", async () => {
    const host = gatedHost([requirement()]);
    const refused = await call(createPaidFetch({ accountId: PAYER, privateKey: KEY }, { payee: HOST_EVM, ceiling: ceiling(false).c, accounts: accounts(), transport: host.transport as typeof fetch })).catch((e) => e);
    expect(refused).toMatchObject({ type: "service_payment_ceiling", signed: false });
    expect(host.signatures).toHaveLength(0);
  });

  it("reports a host that rejects a sent payment as a service payment failure to reconcile", async () => {
    const gated = async () => new Response(null, { status: 402 });
    const rejected = async () => new Response("{}", { status: 402 });
    const failure = await proxyWithFallback("https://host.test", {}, { accountId: PAYER, privateKey: KEY }, rejected as typeof fetch, undefined, gated as typeof fetch).catch((e) => e);
    expect(failure).toMatchObject({ status: 503, type: "host_payment_failed", signed: true });
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("global host payment ceiling", () => {
  const pool = new Pool({ connectionString: database, max: 12 });
  const now = Date.UTC(2031, 0, 2, 12);
  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM usage_counters WHERE subject LIKE 'x402:treasury:%'`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("admits concurrent payments only up to the daily units and payment count", async () => {
    const byUnits = new PgX402Ceiling({ dailyUnits: 5_000n, dailyPayments: 100 }, pool);
    const units = await Promise.all(Array.from({ length: 10 }, () => byUnits.claim(1000n, now)));
    expect(units.filter(Boolean)).toHaveLength(5);

    await pool.query(`DELETE FROM usage_counters WHERE subject LIKE 'x402:treasury:%'`);
    const byCount = new PgX402Ceiling({ dailyUnits: 1_000_000n, dailyPayments: 3 }, pool);
    const counted = await Promise.all(Array.from({ length: 8 }, () => byCount.claim(10n, now)));
    expect(counted.filter(Boolean)).toHaveLength(3);
    expect(await byCount.claim(10n, now + 86_400_000)).toBe(true); // a new UTC day starts fresh
  });
});
