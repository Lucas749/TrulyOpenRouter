import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { AgentError, normalizePolicy, PgAgents } from "../src/agents.js";

describe("agent policy validation", () => {
  it("accepts bounded limits and rejects malformed ones", () => {
    const p = normalizePolicy({ dailyCredits: 100, monthlyCredits: "2000", maxRequestCredits: 5, models: ["qwen2.5:0.5b"], requestsPerMinute: 30, maxConcurrent: 2, credentialTtlDays: 30 });
    expect(p).toMatchObject({ dailyCredits: 100, monthlyCredits: 2000, lifetimeCredits: null, maxRequestCredits: 5, models: ["qwen2.5:0.5b"], regions: null, verifiedOnly: false, requestsPerMinute: 30, maxConcurrent: 2, credentialTtlDays: 30, exceptions: { credits: true } });
    expect(normalizePolicy({ exceptions: { credits: false } }).exceptions.credits).toBe(false);
    expect(() => normalizePolicy({ dailyCredits: -1 })).toThrow(AgentError);
    expect(() => normalizePolicy({ dailyCredits: 1.5 })).toThrow("whole");
    expect(() => normalizePolicy({ models: "qwen" })).toThrow("Models");
    expect(() => normalizePolicy({ requestsPerMinute: 0 })).toThrow("Requests per minute");
    expect(() => normalizePolicy({ regions: ["USA"] })).toThrow("Regions");
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("agent identities and credentials", () => {
  const pool = new Pool({ connectionString: database });
  const agents = new PgAgents(pool);

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM agents WHERE owner_user_id LIKE 'did:privy:test-%'`);
    await pool.query(`DELETE FROM team_finance WHERE org_id = 'test-agents'`);
    await pool.query(`INSERT INTO team_finance (org_id, created_at, updated_at) VALUES ('test-agents', 1, 1)`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("stores only a salted hash and resolves the secret shown once", async () => {
    const { agent, key, credential } = await agents.create({ name: "Research", ownerUserId: "did:privy:test-owner", orgId: null, sponsorDid: null, policy: normalizePolicy({ dailyCredits: 10 }) });
    expect(key).toMatch(/^tor_sk_agt_/);
    expect(agent).toMatchObject({ payerKind: "personal", budgetLabel: `agent:${agent.id}`, state: "ready", policyRevision: 1 });
    const { rows } = await pool.query(`SELECT * FROM agent_credentials WHERE agent_id = $1`, [agent.id]);
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(rows[0].prefix).toBe(credential.prefix);
    expect((await agents.authenticate(key))?.agent.id).toBe(agent.id);
    expect(await agents.authenticate(`${key.slice(0, -1)}x`)).toBeNull();
    expect(await agents.authenticate("tor_sk_legacykey")).toBeNull();
  });

  it("rotates without changing identity or payer and revokes old secrets", async () => {
    const { agent, key } = await agents.create({ name: "Team agent", ownerUserId: "did:privy:test-member", orgId: "test-agents", sponsorDid: "did:privy:test-member", policy: normalizePolicy({}) });
    expect(agent).toMatchObject({ payerKind: "team", budgetLabel: null, orgId: "test-agents" });
    const rotated = await agents.rotate(agent.id);
    expect(await agents.authenticate(key)).toBeNull();
    const resolved = await agents.authenticate(rotated.key);
    expect(resolved?.agent).toMatchObject({ id: agent.id, payerKind: "team", orgId: "test-agents" });
    expect((await agents.credentials(agent.id)).filter((c) => c.revokedAt === null)).toHaveLength(1);
    await agents.setState(agent.id, "paused");
    await expect(agents.setState(agent.id, "paused")).rejects.toMatchObject({ status: 409 });
    await agents.setState(agent.id, "revoked");
    expect(await agents.authenticate(rotated.key)).toBeNull();
    await expect(agents.rotate(agent.id)).rejects.toMatchObject({ status: 409 });
    await expect(agents.setState(agent.id, "ready")).rejects.toMatchObject({ status: 409 });
  });

  it("expires credentials and serializes policy revisions", async () => {
    const { agent, key } = await agents.create({ name: "Short lived", ownerUserId: "did:privy:test-owner", orgId: null, sponsorDid: null, policy: normalizePolicy({ credentialTtlDays: 1 }) });
    expect(await agents.authenticate(key, Date.now() + 2 * 86_400_000)).toBeNull();
    const updated = await agents.updatePolicy(agent.id, normalizePolicy({ dailyCredits: 50 }), 1);
    expect(updated).toMatchObject({ policyRevision: 2, policy: { dailyCredits: 50 } });
    await expect(agents.updatePolicy(agent.id, normalizePolicy({ dailyCredits: 500 }), 1)).rejects.toMatchObject({ status: 409, type: "revision_conflict" });
    await expect(agents.create({ name: "Bad", ownerUserId: "did:privy:test-owner", orgId: "test-agents", sponsorDid: null, policy: normalizePolicy({}) })).rejects.toMatchObject({ status: 400 });
    expect((await agents.listForOwner("did:privy:test-owner")).map((a) => a.id)).toContain(agent.id);
  });
});
