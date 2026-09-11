import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { boundedCompletion, PgBillingRequests } from "../src/billing.js";
import { buildReceipt } from "../src/receipts.js";

describe("bounded subscription requests", () => {
  const body = { model: "qwen", messages: [{ role: "user", content: "hello" }] };
  it("enforces a finite completion ceiling and bounds the text request", () => {
    expect(boundedCompletion(body).body).toMatchObject({ max_tokens: 512, max_completion_tokens: 512, stream: false, n: 1 });
    for (const bad of [0, -1, 4097, "4096", 1.5]) expect(() => boundedCompletion({ ...body, max_tokens: bad })).toThrow();
    expect(() => boundedCompletion({ ...body, n: 10 })).toThrow();
    expect(() => boundedCompletion({ ...body, messages: [{ role: "user", content: "x".repeat(70_000) }] })).toThrow();
    expect(boundedCompletion({ ...body, max_tokens: 4 }).completionCeiling).toBe(4);
  });
  it("keeps simultaneous identical completions distinct by request and payer", () => {
    const input = { promptHash: "p", completionHash: "c", modelDigest: "m", host: "h", priceWei: "1", latencyMs: 2 };
    const a = buildReceipt({ ...input, requestId: "a", user: "alice" });
    const b = buildReceipt({ ...input, requestId: "b", user: "bob" });
    expect(a.id).not.toBe(b.id);
    expect(buildReceipt(a).id).toBe(a.id);
  });
});

// TEST_DATABASE_URL must point to an isolated disposable database.
const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
integration("durable billing reservations", () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  beforeEach(async () => {
    await pool.query(readFileSync("schema.sql", "utf8"));
    await pool.query("TRUNCATE billing_requests");
  });
  afterAll(() => pool.end());

  it("permits one pending request per payer across service instances", async () => {
    const results = await Promise.all([
      new PgBillingRequests(pool).acquire("0xABC", "request-a"),
      new PgBillingRequests(pool).acquire("0xabc", "request-b"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await new PgBillingRequests(pool).acquire("0xdef", "request-c")).toBe(true);
  });

  it("retains uncertain submissions after restart and ignores another request's release", async () => {
    const first = new PgBillingRequests(pool);
    expect(await first.acquire("0xabc", "request-a")).toBe(true);
    await first.submitted("0xabc", "request-a", "host-a", 5n);
    const restarted = new PgBillingRequests(pool);
    await restarted.release("0xabc", "request-b");
    expect(await restarted.acquire("0xabc", "request-b")).toBe(false);
    expect((await pool.query("SELECT * FROM billing_requests")).rows[0]).toMatchObject({ submitted: true, maximum_credits: "5", host: "host-a" });
    await restarted.release("0xabc", "request-a");
    expect(await restarted.acquire("0xabc", "request-b")).toBe(true);
  });
});
