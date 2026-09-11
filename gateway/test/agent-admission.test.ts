import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/index.js";
import { PgAccounting, periods } from "../src/accounting.js";
import { PgAgents } from "../src/agents.js";
import { PgApprovals } from "../src/approvals.js";
import { budgetAddressFor } from "../src/budget.js";
import { MemoryReceiptLog } from "../src/receipts.js";
import { SubscriberError } from "../src/subscriber.js";
import { normalizeSnapshot, PgTeams } from "../src/teams.js";

// End-to-end admission against real Postgres stores: agent credentials, strict
// counters, approvals, and settlement, with a stub host and stub vault debit.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;

const OWNER = privateKeyToAccount(generatePrivateKey());
const MEMBER = privateKeyToAccount(generatePrivateKey());
const TEAM_WALLET = `0x${"7e".repeat(20)}`;
const HOST = `0x${"22".repeat(20)}` as const;
const ORG = "adm-org";

integration("agent admission", () => {
  const pool = new Pool({ connectionString: database, max: 10 });
  const teams = new PgTeams(pool);
  const agents = new PgAgents(pool);
  const accounting = new PgAccounting(pool);
  const approvals = new PgApprovals(pool);
  const servers: Server[] = [];
  const sessions: Record<string, { userId: string; wallets: `0x${string}`[] }> = {
    "owner-session": { userId: "did:privy:adm-owner", wallets: [OWNER.address.toLowerCase() as `0x${string}`] },
    "member-session": { userId: "did:privy:adm-member", wallets: [MEMBER.address.toLowerCase() as `0x${string}`] },
    "outsider-session": { userId: "did:privy:adm-outsider", wallets: [] },
  };
  let base = "";
  let served = vi.fn();
  let settle = vi.fn();

  const listen = (app: ReturnType<typeof express>) => {
    const server = app.listen(0);
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const members = (memberAllowance: number | null, memberStatus = "active") => [
    { did: "did:privy:adm-owner", wallet: OWNER.address, role: "owner", status: "active" },
    { did: "did:privy:adm-member", wallet: MEMBER.address, role: "member", status: memberStatus, allowanceCredits: memberAllowance },
  ];
  const api = (path: string, token?: string, body?: unknown, method?: string) =>
    fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const chat = (key: string, content = "hello", extra: Record<string, unknown> = {}) =>
    api("/v1/chat/completions", key, { model: "qwen", messages: [{ role: "user", content }], max_tokens: 16, ...extra });
  const createAgent = async (token: string, body: Record<string, unknown>) => {
    const r = await api("/api/agents", token, body);
    return { status: r.status, body: (await r.json()) as any };
  };
  const setSpent = (subject: string, period: string, spent: number) =>
    pool.query(`INSERT INTO usage_counters (subject, period, spent) VALUES ($1, $2, $3) ON CONFLICT (subject, period) DO UPDATE SET spent = EXCLUDED.spent`, [subject, period, spent]);
  const usage = async (subject: string, period: string) => (await accounting.usage([{ subject, period }]))[0];
  const approve = async (approvalId: string) => {
    const view: any = await (await api(`/api/agent-approvals/${approvalId}`, "owner-session")).json();
    const signature = await OWNER.signMessage({ message: view.message });
    return api(`/api/agent-approvals/${approvalId}/decide`, "owner-session", { decision: "approve", method: "org_owner", signature });
  };

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    vi.stubEnv("BUDGET_MASTER", `0x${"ab".repeat(32)}`);
    await pool.query(`DELETE FROM usage_counters WHERE subject LIKE 'member:adm-%' OR subject IN (SELECT 'agent:' || id FROM agents WHERE owner_user_id LIKE 'did:privy:adm-%')`);
    await pool.query(`DELETE FROM agents WHERE owner_user_id LIKE 'did:privy:adm-%'`);
    await pool.query(`DELETE FROM team_finance WHERE org_id LIKE 'adm-%'`);
    await teams.applySnapshot(normalizeSnapshot(ORG, { defaultAllowanceCredits: null, members: members(1000) }));
    await teams.setTeamWallet(ORG, { name: "Admission", walletId: "w-adm", walletAddress: TEAM_WALLET, quorumId: "q", policyId: "p", approverUserId: "did:privy:adm-owner", payoutRecipients: [] });
    served = vi.fn();
    settle = vi.fn(async () => "0xdebit");
    const upstream = express().use(express.json());
    upstream.post("/v1/chat/completions", (_req, res) => {
      served();
      res.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    });
    const endpoint = listen(upstream);
    base = listen(createApp({
      verifySession: async (token) => {
        if (!sessions[token]) throw new SubscriberError(401, "authentication_required", "Invalid session");
        return sessions[token];
      },
      verifySubscriber: async () => {
        throw new SubscriberError(401, "authentication_required", "No personal wallet in this test");
      },
      teams, agents, accounting, approvals,
      receipts: new MemoryReceiptLog(),
      settle,
      subscriptionCredits: async () => 1_000_000n,
      appOrigin: "https://tor.test",
      // 5 credits per request, no token pricing: admitted maximum equals actual cost.
      fetchHosts: async () => [{ address: HOST, modelId: "qwen", modelDigest: "0xabc", endpoint, pricePerReq: 500_000n, pricePer1kTokens: 0n, active: true, stake: 1n, lastHeartbeat: Date.now() }],
    }));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });
  afterAll(async () => {
    await pool.end();
  });

  it("creates team agents only within the sponsor's limits and bills the team wallet", async () => {
    expect((await createAgent("outsider-session", { name: "Spy", orgId: ORG, policy: {} })).status).toBe(404);
    expect((await createAgent("member-session", { name: "Too big", orgId: ORG, policy: { monthlyCredits: 2000 } })).body.error.type).toBe("exceeds_parent");
    const created = await createAgent("member-session", { name: "Research", orgId: ORG, policy: { dailyCredits: 100 } });
    expect(created.status).toBe(200);
    expect(created.body.key).toMatch(/^tor_sk_agt_/);
    expect(created.body.agent).toMatchObject({ orgId: ORG, sponsorDid: "did:privy:adm-member", payerKind: "team", budgetAddress: null });
    const response = await chat(created.body.key);
    expect(response.status).toBe(200);
    expect(served).toHaveBeenCalledTimes(1);
    expect((settle.mock.calls[0] as unknown[])[0]).toBe(TEAM_WALLET);
    const self: any = await (await api("/v1/agent/self", created.body.key)).json();
    expect(self.usage.find((u: any) => u.period === periods().day)).toMatchObject({ spent: 5, reserved: 0, limit: 100, remaining: 95 });
    expect(await usage("member:adm-org:did:privy:adm-member", periods().month)).toMatchObject({ spent: 5, reserved: 0 });
    expect((await api(`/api/agents/${created.body.agent.id}`, "outsider-session")).status).toBe(404);
  });

  it("turns an over-limit request into one approval, pays nobody, and resumes exactly once after the owner approves", async () => {
    const { body } = await createAgent("member-session", { name: "Research", orgId: ORG, policy: { dailyCredits: 100 } });
    const key = body.key;
    const agentSubject = `agent:${body.agent.id}`;
    await setSpent(agentSubject, periods().day, 98);

    const first = await chat(key);
    expect(first.status).toBe(403);
    const required = ((await first.json()) as any).error;
    expect(required).toMatchObject({
      type: "approval_required", constraint: "daily_credits", remaining_credits: "2", maximum_request_credits: "5", additional_credits_requested: "3",
      approval_methods: ["org_owner"], poll_after_seconds: 5,
    });
    expect(required.approval_url).toBe(`https://tor.test/approvals/${required.approval_id}`);
    expect(served).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect((await usage(agentSubject, periods().day)).reserved).toBe(0);

    const repeat: any = await (await chat(key)).json();
    expect(repeat.error.approval_id).toBe(required.approval_id);
    expect(((await (await api(`/v1/agent/approvals/${required.approval_id}`, key)).json()) as any).state).toBe("pending");
    // The agent credential can read its approval but never decide it.
    expect((await api(`/api/agent-approvals/${required.approval_id}/decide`, key, { decision: "approve", method: "org_owner", signature: "0x" })).status).toBe(401);
    // The sponsoring member can view but is not an organization owner.
    const memberView: any = await (await api(`/api/agent-approvals/${required.approval_id}`, "member-session")).json();
    expect(memberView.canApprove).toEqual({ org_owner: false, ledger: false });
    expect((await api(`/api/agent-approvals/${required.approval_id}/decide`, "member-session", { decision: "approve", method: "org_owner", signature: await MEMBER.signMessage({ message: memberView.message }) })).status).toBe(403);

    expect((await approve(required.approval_id)).status).toBe(200);
    const resumed = await chat(key);
    expect(resumed.status).toBe(200);
    expect(served).toHaveBeenCalledTimes(1);
    expect(await usage(agentSubject, periods().day)).toMatchObject({ spent: 103, reserved: 0 });
    expect((await approvals.get(required.approval_id))?.state).toBe("consumed");

    const again: any = await (await chat(key)).json();
    expect(again.error.type).toBe("approval_required");
    expect(again.error.approval_id).not.toBe(required.approval_id);
    expect(served).toHaveBeenCalledTimes(1);
  });

  it("applies a grant only to the exact request it approved", async () => {
    const { body } = await createAgent("member-session", { name: "Research", orgId: ORG, policy: { dailyCredits: 100 } });
    await setSpent(`agent:${body.agent.id}`, periods().day, 98);
    const a: any = await (await chat(body.key, "question A")).json();
    expect((await approve(a.error.approval_id)).status).toBe(200);
    const b: any = await (await chat(body.key, "question B")).json();
    expect(b.error.type).toBe("approval_required");
    expect(b.error.approval_id).not.toBe(a.error.approval_id);
    expect((await chat(body.key, "question A")).status).toBe(200);
    expect(served).toHaveBeenCalledTimes(1);
  });

  it("applies pause, rotation, member removal, and revocation before the next admission", async () => {
    const { body } = await createAgent("member-session", { name: "Ops", orgId: ORG, policy: {} });
    const id = body.agent.id;
    expect((await chat(body.key)).status).toBe(200);
    expect((await api(`/api/agents/${id}/pause`, "member-session", {})).status).toBe(200);
    expect(((await (await chat(body.key)).json()) as any).error.type).toBe("agent_paused");
    expect((await api(`/api/agents/${id}/resume`, "member-session", {})).status).toBe(200);
    const rotated: any = await (await api(`/api/agents/${id}/rotate`, "member-session", {})).json();
    expect((await chat(body.key)).status).toBe(401);
    expect((await chat(rotated.key)).status).toBe(200);
    await teams.applySnapshot(normalizeSnapshot(ORG, { defaultAllowanceCredits: null, members: members(1000, "removed") }));
    expect(((await (await chat(rotated.key)).json()) as any).error.type).toBe("sponsor_inactive");
    expect((await api(`/api/agents/${id}/revoke`, "owner-session", {})).status).toBe(200);
    expect((await chat(rotated.key)).status).toBe(401);
    expect(served).toHaveBeenCalledTimes(2);
  });

  it("bills personal agents from their budget account and needs a Ledger for exceptions", async () => {
    const { body } = await createAgent("member-session", { name: "Personal", policy: { dailyCredits: 5 } });
    expect(body.agent).toMatchObject({ payerKind: "personal", orgId: null, budgetAddress: budgetAddressFor(`agent:${body.agent.id}`) });
    expect((await chat(body.key)).status).toBe(200);
    expect((settle.mock.calls[0] as unknown[])[0]).toBe(budgetAddressFor(`agent:${body.agent.id}`)!.toLowerCase());
    const capped = await chat(body.key);
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as any).error.message).toContain("Enroll a Ledger");
    expect(served).toHaveBeenCalledTimes(1);
  });

  it("stops team members at their monthly allowance and voids approvals when the policy changes", async () => {
    await teams.applySnapshot(normalizeSnapshot(ORG, { defaultAllowanceCredits: null, members: members(5) }));
    expect((await api("/v1/chat/completions", "member-session", { model: "qwen", messages: [{ role: "user", content: "hi" }], max_tokens: 16, tor_team: ORG })).status).toBe(200);
    const capped = await api("/v1/chat/completions", "member-session", { model: "qwen", messages: [{ role: "user", content: "hi" }], max_tokens: 16, tor_team: ORG });
    expect(capped.status).toBe(429);
    expect(served).toHaveBeenCalledTimes(1);

    await teams.applySnapshot(normalizeSnapshot(ORG, { defaultAllowanceCredits: null, members: members(1000) }));
    const { body } = await createAgent("member-session", { name: "Research", orgId: ORG, policy: { dailyCredits: 100 } });
    await setSpent(`agent:${body.agent.id}`, periods().day, 98);
    const pending: any = await (await chat(body.key)).json();
    const patched = await api(`/api/agents/${body.agent.id}/policy`, "member-session", { policy: { dailyCredits: 99 }, expectedRevision: 1 }, "PATCH");
    expect(patched.status).toBe(200);
    expect((await approvals.get(pending.error.approval_id))?.state).toBe("cancelled");
    expect((await approve(pending.error.approval_id)).status).toBe(409);
  });
});
