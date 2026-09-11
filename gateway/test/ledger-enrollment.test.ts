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
import { challengeField, issueChallenge, verifyChallenge } from "../src/ledger.js";
import { MemoryReceiptLog } from "../src/receipts.js";
import { SubscriberError } from "../src/subscriber.js";
import { normalizeSnapshot, PgTeams } from "../src/teams.js";

describe("ledger challenges", () => {
  it("accept only unmodified, unexpired gateway messages", () => {
    const { message, token, expiresAt } = issueChallenge(["TrulyOpenRouter Ledger enrollment", "approver: 0xabc"], 1_000);
    expect(verifyChallenge(message, token, 1_000)).toBe(message);
    expect(challengeField(message, "approver")).toBe("0xabc");
    expect(() => verifyChallenge(message.replace("0xabc", "0xdef"), token, 1_000)).toThrow("not issued");
    expect(() => verifyChallenge(message, token, expiresAt + 1)).toThrow("expired");
    expect(() => verifyChallenge(message, "nope", 1_000)).toThrow("required");
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;

const OWNER = privateKeyToAccount(generatePrivateKey());
const MEMBER = privateKeyToAccount(generatePrivateKey());
const LEDGER_ONE = privateKeyToAccount(generatePrivateKey()); // stand-ins for device Ethereum keys
const LEDGER_TWO = privateKeyToAccount(generatePrivateKey());
const ORG = "ldg-org";

integration("ledger enrollment and approvals", () => {
  const pool = new Pool({ connectionString: database, max: 10 });
  const teams = new PgTeams(pool);
  const agents = new PgAgents(pool);
  const accounting = new PgAccounting(pool);
  const approvals = new PgApprovals(pool);
  const servers: Server[] = [];
  const sessions: Record<string, { userId: string; wallets: `0x${string}`[] }> = {
    "owner-session": { userId: "did:privy:ldg-owner", wallets: [OWNER.address.toLowerCase() as `0x${string}`] },
    "member-session": { userId: "did:privy:ldg-member", wallets: [MEMBER.address.toLowerCase() as `0x${string}`] },
  };
  let base = "";
  let served = vi.fn();

  const api = (path: string, token?: string, body?: unknown, method?: string) =>
    fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });
  const challenge = async (session: string, agentId: string, address: string | null) => json(await api(`/api/agents/${agentId}/ledger/challenge`, session, { address }));

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    vi.stubEnv("BUDGET_MASTER", `0x${"cd".repeat(32)}`);
    await pool.query(`DELETE FROM usage_counters WHERE subject LIKE 'member:ldg-%' OR subject IN (SELECT 'agent:' || id FROM agents WHERE owner_user_id LIKE 'did:privy:ldg-%')`);
    await pool.query(`DELETE FROM agents WHERE owner_user_id LIKE 'did:privy:ldg-%'`);
    await pool.query(`DELETE FROM team_finance WHERE org_id LIKE 'ldg-%'`);
    await teams.applySnapshot(normalizeSnapshot(ORG, { defaultAllowanceCredits: null, members: [
      { did: "did:privy:ldg-owner", wallet: OWNER.address, role: "owner", status: "active" },
      { did: "did:privy:ldg-member", wallet: MEMBER.address, role: "member", status: "active" },
    ] }));
    await teams.setTeamWallet(ORG, { name: "Ledger", walletId: "w-ldg", walletAddress: `0x${"5a".repeat(20)}`, quorumId: "q", policyId: "p", approverUserId: "did:privy:ldg-owner", payoutRecipients: [] });
    served = vi.fn();
    const upstream = express().use(express.json());
    upstream.post("/v1/chat/completions", (_req, res) => {
      served();
      res.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    });
    const upstreamServer = upstream.listen(0);
    servers.push(upstreamServer);
    const endpoint = `http://127.0.0.1:${(upstreamServer.address() as { port: number }).port}`;
    const gateway = createApp({
      verifySession: async (token) => {
        if (!sessions[token]) throw new SubscriberError(401, "authentication_required", "Invalid session");
        return sessions[token];
      },
      teams, agents, accounting, approvals,
      receipts: new MemoryReceiptLog(),
      settle: async () => "0xdebit",
      subscriptionCredits: async () => 1_000_000n,
      appOrigin: "https://tor.test",
      fetchHosts: async () => [{ address: `0x${"33".repeat(20)}`, modelId: "qwen", modelDigest: "0xabc", endpoint, pricePerReq: 500_000n, pricePer1kTokens: 0n, active: true, stake: 1n, lastHeartbeat: Date.now() }],
    }).listen(0);
    servers.push(gateway);
    base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });
  afterAll(async () => {
    await pool.end();
  });

  it("enrolls, replaces, and removes a personal agent's Ledger only with the right devices", async () => {
    const created = await json(await api("/api/agents", "owner-session", { name: "Personal", policy: { dailyCredits: 5 } }));
    const id = created.body.agent.id;
    expect((await challenge("member-session", id, LEDGER_ONE.address)).status).toBe(404);

    const enroll = await challenge("owner-session", id, LEDGER_ONE.address);
    expect(enroll.body.action).toBe("enroll");
    expect((await api(`/api/agents/${id}/ledger`, "owner-session", { ...enroll.body, signature: await LEDGER_TWO.signMessage({ message: enroll.body.message }) })).status).toBe(401);
    const tampered = enroll.body.message.replace(LEDGER_ONE.address.toLowerCase(), LEDGER_TWO.address.toLowerCase());
    expect((await api(`/api/agents/${id}/ledger`, "owner-session", { message: tampered, token: enroll.body.token, signature: await LEDGER_TWO.signMessage({ message: tampered }) })).status).toBe(400);
    const signedEnroll = { ...enroll.body, signature: await LEDGER_ONE.signMessage({ message: enroll.body.message }) };
    const enrolled = await json(await api(`/api/agents/${id}/ledger`, "owner-session", signedEnroll));
    expect(enrolled.body.agent).toMatchObject({ ledgerAddress: LEDGER_ONE.address.toLowerCase(), ledgerRevision: 1 });
    expect((await api(`/api/agents/${id}/ledger`, "owner-session", signedEnroll)).status).toBe(409); // single use

    const replace = await challenge("owner-session", id, LEDGER_TWO.address);
    expect(replace.body.action).toBe("replace");
    const newOnly = { ...replace.body, signature: await LEDGER_TWO.signMessage({ message: replace.body.message }) };
    expect((await api(`/api/agents/${id}/ledger`, "owner-session", newOnly)).status).toBe(400); // the current device must sign too
    expect((await api(`/api/agents/${id}/ledger`, "owner-session", { ...newOnly, currentSignature: await LEDGER_TWO.signMessage({ message: replace.body.message }) })).status).toBe(401);
    const replaced = await json(await api(`/api/agents/${id}/ledger`, "owner-session", { ...newOnly, currentSignature: await LEDGER_ONE.signMessage({ message: replace.body.message }) }));
    expect(replaced.body.agent).toMatchObject({ ledgerAddress: LEDGER_TWO.address.toLowerCase(), ledgerRevision: 2 });

    const remove = await challenge("owner-session", id, null);
    expect(remove.body.action).toBe("remove");
    expect((await api(`/api/agents/${id}/ledger`, "owner-session", { ...remove.body })).status).toBe(400); // a login alone cannot disable protection
    expect((await api(`/api/agents/${id}/ledger`, "owner-session", { ...remove.body, signature: await LEDGER_ONE.signMessage({ message: remove.body.message }) })).status).toBe(401);
    const removed = await json(await api(`/api/agents/${id}/ledger`, "owner-session", { ...remove.body, signature: await LEDGER_TWO.signMessage({ message: remove.body.message }) }));
    expect(removed.body.agent).toMatchObject({ ledgerAddress: null, ledgerRevision: 3 });
  });

  it("requires the enrolled Ledger to widen a protected personal agent", async () => {
    const created = await json(await api("/api/agents", "owner-session", { name: "Protected", policy: { dailyCredits: 5, models: ["qwen"] } }));
    const id = created.body.agent.id;
    const enroll = await challenge("owner-session", id, LEDGER_ONE.address);
    await api(`/api/agents/${id}/ledger`, "owner-session", { ...enroll.body, signature: await LEDGER_ONE.signMessage({ message: enroll.body.message }) });

    const wider = { dailyCredits: 50, models: ["qwen"] };
    const denied = await json(await api(`/api/agents/${id}/policy`, "owner-session", { policy: wider, expectedRevision: 1 }, "PATCH"));
    expect(denied).toMatchObject({ status: 403, body: { error: { type: "ledger_required" } } });
    expect((await api(`/api/agents/${id}/policy`, "owner-session", { policy: { dailyCredits: 2, models: ["qwen"] }, expectedRevision: 1 }, "PATCH")).status).toBe(200); // narrowing needs no device

    const policyChallenge = await json(await api(`/api/agents/${id}/policy/challenge`, "owner-session", { policy: wider }));
    const otherPolicy = { policy: { dailyCredits: 500, models: ["qwen"] }, expectedRevision: 2, ledger: { ...policyChallenge.body, signature: await LEDGER_ONE.signMessage({ message: policyChallenge.body.message }) } };
    expect((await api(`/api/agents/${id}/policy`, "owner-session", otherPolicy, "PATCH")).status).toBe(409); // approval covers only the reviewed policy
    const approved = await json(await api(`/api/agents/${id}/policy`, "owner-session", { policy: wider, expectedRevision: 2, ledger: { ...policyChallenge.body, signature: await LEDGER_ONE.signMessage({ message: policyChallenge.body.message }) } }, "PATCH"));
    expect(approved).toMatchObject({ status: 200, body: { agent: { policyRevision: 3, policy: { dailyCredits: 50 } } } });
  });

  it("lets a team agent's over-limit request be approved on its enrolled Ledger and resume once", async () => {
    const created = await json(await api("/api/agents", "member-session", { name: "Team agent", orgId: ORG, policy: { dailyCredits: 100 } }));
    const { agent, key } = created.body;
    expect((await challenge("member-session", agent.id, LEDGER_ONE.address)).status).toBe(404); // team owners enroll team approvers
    const enroll = await challenge("owner-session", agent.id, LEDGER_ONE.address);
    await api(`/api/agents/${agent.id}/ledger`, "owner-session", { ...enroll.body, signature: await LEDGER_ONE.signMessage({ message: enroll.body.message }) });
    await pool.query(`INSERT INTO usage_counters (subject, period, spent) VALUES ($1, $2, 98)`, [`agent:${agent.id}`, periods().day]);

    const chat = () => api("/v1/chat/completions", key, { model: "qwen", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    const required = await json(await chat());
    expect(required.body.error).toMatchObject({ type: "approval_required", approval_methods: ["org_owner", "ledger"], additional_credits_requested: "3" });
    const view = await json(await api(`/api/agent-approvals/${required.body.error.approval_id}`, "owner-session"));
    expect(view.body.canApprove).toEqual({ org_owner: true, ledger: true });
    const wrongDevice = await api(`/api/agent-approvals/${required.body.error.approval_id}/decide`, "owner-session", { decision: "approve", method: "ledger", signature: await LEDGER_TWO.signMessage({ message: view.body.message }) });
    expect(wrongDevice.status).toBe(401);
    const decided = await api(`/api/agent-approvals/${required.body.error.approval_id}/decide`, "owner-session", { decision: "approve", method: "ledger", signature: await LEDGER_ONE.signMessage({ message: view.body.message }) });
    expect(decided.status).toBe(200);
    expect((await chat()).status).toBe(200);
    expect(served).toHaveBeenCalledTimes(1);
    expect((await approvals.evidence(required.body.error.approval_id))).toMatchObject({ method: "ledger", signer: LEDGER_ONE.address.toLowerCase() });
    // Changing the enrollment voids any other open approval for this agent.
    const next = await json(await chat());
    const replace = await challenge("owner-session", agent.id, LEDGER_TWO.address);
    await api(`/api/agents/${agent.id}/ledger`, "owner-session", { ...replace.body, signature: await LEDGER_TWO.signMessage({ message: replace.body.message }), currentSignature: await LEDGER_ONE.signMessage({ message: replace.body.message }) });
    expect((await approvals.get(next.body.error.approval_id))?.state).toBe("cancelled");
  });
});
