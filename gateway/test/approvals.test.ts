import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { normalizePolicy, PgAgents, type Agent } from "../src/agents.js";
import { approvalMessage, approveByLedgerSignature, decideAgentApproval, GRANT_TTL_MS, MAX_PENDING_PER_AGENT, PgApprovals, type AgentApproval, type ApprovalMethod } from "../src/approvals.js";
import { normalizeSnapshot, PgTeams } from "../src/teams.js";

const OWNER = privateKeyToAccount(generatePrivateKey());
const OTHER_OWNER = privateKeyToAccount(generatePrivateKey());
const MEMBER = privateKeyToAccount(generatePrivateKey());
const NEW_MEMBER = privateKeyToAccount(generatePrivateKey());
const LEDGER = privateKeyToAccount(generatePrivateKey()); // stands in for the enrolled device's Ethereum key
const ORIGIN = "https://trulyopenrouter.test";

describe("approval message", () => {
  it("binds origin, network, agent, payer, request, exact amounts, limits, revisions, nonce, and expiry", () => {
    const a = { id: "apr_1", agentId: "agt_1", orgId: "org_1", memberDid: "did:privy:m", methods: ["org_owner"], requestHash: "abc", idempotencyKey: null, model: "qwen", maximumRequestCredits: 5, additionalCredits: 3, limits: [{ subject: "agent:agt_1", period: "d:2026-09-11", label: "agent daily credits", limit: 100, extra: 3 }], policyRevision: 2, membershipRevision: 7, ledgerRevision: 0, nonce: "n1", expiresAt: 123, state: "pending", decidedAt: null, grantExpiresAt: null, reservedRequestId: null, createdAt: 1 } as AgentApproval;
    const m = approvalMessage(a, { origin: ORIGIN, agentName: "Research" });
    for (const line of [`origin: ${ORIGIN}`, "network: hedera-testnet", "approval: apr_1", "agent: agt_1 (Research)", "payer: team org_1", "member: did:privy:m", "model: qwen", "request: abc", "request maximum: 5 credits", "additional: 3 credits", "limit: agent daily credits 100 +3", "revisions: policy 2, membership 7, ledger 0", "nonce: n1", "expires: 123"]) {
      expect(m.split("\n")).toContain(line);
    }
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("agent approvals", () => {
  const pool = new Pool({ connectionString: database, max: 12 });
  const teams = new PgTeams(pool);
  const agents = new PgAgents(pool);
  const approvals = new PgApprovals(pool);
  const deps = { approvals, agents, teams, origin: ORIGIN };
  const identity = (userId: string, account: PrivateKeyAccount) => ({ userId, wallets: [account.address.toLowerCase()] });
  const owner = identity("did:privy:appr-owner", OWNER);
  let teamAgent: Agent;
  let personalAgent: Agent;

  const snapshot = (members: unknown[]) => teams.applySnapshot(normalizeSnapshot("appr-org", { defaultAllowanceCredits: null, members }));
  const baseMembers = [
    { did: "did:privy:appr-owner", wallet: OWNER.address, role: "owner", status: "active" },
    { did: "did:privy:appr-member", wallet: MEMBER.address, role: "member", status: "active" },
  ];
  async function request(agent: Agent, hash = "req-1", methods: ApprovalMethod[] = ["org_owner"]) {
    const current = (await agents.get(agent.id))!;
    return approvals.requestFor({
      agentId: current.id, orgId: current.orgId, memberDid: current.sponsorDid, methods, requestHash: hash, idempotencyKey: null, model: "qwen",
      maximumRequestCredits: 5, additionalCredits: 3,
      limits: [{ subject: `agent:${current.id}`, period: "d:2026-09-11", label: "agent daily credits", limit: 100, extra: 3 }],
      policyRevision: current.policyRevision, membershipRevision: current.orgId ? (await teams.team(current.orgId))!.membershipRevision : 0, ledgerRevision: current.ledgerRevision,
    });
  }
  async function sign(account: PrivateKeyAccount, approval: AgentApproval) {
    const agent = (await agents.get(approval.agentId))!;
    return account.signMessage({ message: approvalMessage(approval, { origin: ORIGIN, agentName: agent.name }) });
  }

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM agents WHERE owner_user_id LIKE 'did:privy:appr-%'`);
    await pool.query(`DELETE FROM team_finance WHERE org_id LIKE 'appr-%'`);
    await snapshot(baseMembers);
    await teams.applySnapshot(normalizeSnapshot("appr-other", { defaultAllowanceCredits: null, members: [{ did: "did:privy:appr-other-owner", wallet: OTHER_OWNER.address, role: "owner", status: "active" }] }));
    teamAgent = (await agents.create({ name: "Research", ownerUserId: "did:privy:appr-member", orgId: "appr-org", sponsorDid: "did:privy:appr-member", policy: normalizePolicy({ dailyCredits: 100 }) })).agent;
    personalAgent = (await agents.create({ name: "Personal", ownerUserId: "did:privy:appr-owner", orgId: null, sponsorDid: null, policy: normalizePolicy({ dailyCredits: 10 }) })).agent;
    await pool.query(`UPDATE agents SET ledger_address = $1, ledger_revision = 1 WHERE id = $2`, [LEDGER.address.toLowerCase(), personalAgent.id]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("reuses one open approval per request and bounds the pending queue", async () => {
    const first = await request(teamAgent);
    const again = await request(teamAgent);
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, approval: { id: first.approval.id } });
    const copies = await Promise.all([request(teamAgent, "req-race"), request(teamAgent, "req-race")]);
    expect(new Set(copies.map((c) => c.approval.id)).size).toBe(1);
    for (let i = 3; i <= MAX_PENDING_PER_AGENT; i++) await request(teamAgent, `req-${i}`);
    await expect(request(teamAgent, "req-overflow")).rejects.toMatchObject({ status: 429, type: "approval_queue_full" });
  });

  it("lets an active owner of the same organization approve once with a linked wallet", async () => {
    const { approval } = await request(teamAgent);
    const signature = await sign(OWNER, approval);
    await expect(decideAgentApproval(deps, approval.id, { identity: identity("did:privy:appr-other-owner", OTHER_OWNER) }, { decision: "approve", method: "org_owner", signature: await sign(OTHER_OWNER, approval) })).rejects.toMatchObject({ status: 404 });
    await expect(decideAgentApproval(deps, approval.id, { identity: identity("did:privy:appr-member", MEMBER) }, { decision: "approve", method: "org_owner", signature: await sign(MEMBER, approval) })).rejects.toMatchObject({ status: 403 });
    await expect(decideAgentApproval(deps, approval.id, { identity: { userId: owner.userId, wallets: [] } }, { decision: "approve", method: "org_owner", signature })).rejects.toMatchObject({ status: 401 });
    await expect(decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "ledger", signature })).rejects.toMatchObject({ status: 403, type: "method_not_permitted" });
    const approved = await decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "org_owner", signature });
    expect(approved.state).toBe("approved");
    expect(approved.grantExpiresAt! - approved.decidedAt!).toBe(GRANT_TTL_MS);
    expect(await approvals.evidence(approval.id)).toMatchObject({ method: "org_owner", signer: OWNER.address.toLowerCase(), actorUserId: owner.userId, actorRole: "owner" });
    await expect(decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "org_owner", signature })).rejects.toMatchObject({ status: 409, type: "already_decided" });
  });

  it("refuses altered terms, removed owners, stale revisions, expired windows, and denied requests", async () => {
    const { approval } = await request(teamAgent);
    const altered = await sign(OWNER, { ...approval, additionalCredits: 300 });
    await expect(decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: altered })).rejects.toMatchObject({ status: 401 });
    await expect(decideAgentApproval({ ...deps, now: () => approval.expiresAt + 1 }, approval.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: await sign(OWNER, approval) })).rejects.toMatchObject({ status: 409, type: "expired" });

    const { approval: stale } = await request(teamAgent, "req-stale");
    await snapshot([...baseMembers, { did: "did:privy:appr-new", wallet: NEW_MEMBER.address, role: "member", status: "active" }]);
    await expect(decideAgentApproval(deps, stale.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: await sign(OWNER, stale) })).rejects.toMatchObject({ status: 409, type: "stale_approval" });
    expect((await approvals.get(stale.id))?.state).toBe("cancelled");

    const { approval: policy } = await request(teamAgent, "req-policy");
    await agents.updatePolicy(teamAgent.id, normalizePolicy({ dailyCredits: 200 }), 1);
    await expect(decideAgentApproval(deps, policy.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: await sign(OWNER, policy) })).rejects.toMatchObject({ status: 409, type: "stale_approval" });

    const fresh = (await agents.get(teamAgent.id))!;
    const { approval: removed } = await request(fresh, "req-removed");
    await snapshot([{ did: "did:privy:appr-owner", wallet: OWNER.address, role: "owner", status: "removed" }, { did: "did:privy:appr-new", wallet: NEW_MEMBER.address, role: "owner", status: "active" }, baseMembers[1]]);
    await expect(decideAgentApproval(deps, removed.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: await sign(OWNER, removed) })).rejects.toMatchObject({ status: 404 });

    const { approval: denied } = await request(fresh, "req-denied");
    const newOwner = identity("did:privy:appr-new", NEW_MEMBER);
    await expect(decideAgentApproval(deps, denied.id, { identity: newOwner }, { decision: "deny", method: "org_owner" })).resolves.toMatchObject({ state: "denied" });
    await expect(decideAgentApproval(deps, denied.id, { identity: newOwner }, { decision: "approve", method: "org_owner", signature: await sign(NEW_MEMBER, denied) })).rejects.toMatchObject({ status: 409 });
  });

  it("accepts only the enrolled Ledger for a personal agent, with its owner signed in", async () => {
    const { approval } = await request(personalAgent, "req-personal", ["ledger"]);
    await expect(decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: await sign(OWNER, approval) })).rejects.toMatchObject({ status: 403 });
    await expect(decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "ledger", signature: await sign(OWNER, approval) })).rejects.toMatchObject({ status: 401 });
    await expect(decideAgentApproval(deps, approval.id, { identity: identity("did:privy:appr-member", MEMBER) }, { decision: "approve", method: "ledger", signature: await sign(LEDGER, approval) })).rejects.toMatchObject({ status: 404 });
    const approved = await decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "ledger", signature: await sign(LEDGER, approval) });
    expect(approved.state).toBe("approved");
    expect(await approvals.evidence(approval.id)).toMatchObject({ method: "ledger", signer: LEDGER.address.toLowerCase() });
  });

  it("accepts a relayed terminal approval only when the enrolled Ledger signed this approval's exact message", async () => {
    const { approval } = await request(personalAgent, "req-usb", ["ledger"]);
    const relay = (signature: string, agentId = personalAgent.id) => approveByLedgerSignature(deps, approval.id, agentId, signature);

    await expect(relay("0x1234")).rejects.toMatchObject({ status: 400 });
    await expect(relay(await sign(LEDGER, approval), teamAgent.id)).rejects.toMatchObject({ status: 404 });
    await expect(relay(await sign(OWNER, approval))).rejects.toMatchObject({ status: 401, type: "bad_signature" });
    await expect(relay(await LEDGER.signMessage({ message: "approve anything" }))).rejects.toMatchObject({ status: 401, type: "bad_signature" });
    await expect(relay(await sign(LEDGER, approval))).resolves.toMatchObject({ state: "approved" });
    expect(await approvals.evidence(approval.id)).toMatchObject({ method: "ledger", signer: LEDGER.address.toLowerCase(), actorRole: "enrolled_ledger" });
    await expect(relay(await sign(LEDGER, approval))).rejects.toMatchObject({ status: 409, type: "already_decided" });
  });

  it("refuses a relayed Ledger approval when the Ledger route is not permitted, the window ended, or the policy changed", async () => {
    const ownersOnly = (await request(teamAgent, "req-usb-owner", ["org_owner"])).approval;
    await expect(approveByLedgerSignature(deps, ownersOnly.id, teamAgent.id, await sign(LEDGER, ownersOnly))).rejects.toMatchObject({ status: 403, type: "method_not_permitted" });
    const late = (await request(personalAgent, "req-usb-late", ["ledger"])).approval;
    await expect(approveByLedgerSignature({ ...deps, now: () => late.expiresAt + 1 }, late.id, personalAgent.id, await sign(LEDGER, late))).rejects.toMatchObject({ status: 409, type: "expired" });
    const stale = (await request(personalAgent, "req-usb-stale", ["ledger"])).approval;
    await pool.query(`UPDATE agents SET policy_revision = policy_revision + 1 WHERE id = $1`, [personalAgent.id]);
    await expect(approveByLedgerSignature(deps, stale.id, personalAgent.id, await sign(LEDGER, stale))).rejects.toMatchObject({ status: 409, type: "stale_approval" });
  });

  it("creates at most one grant when owner and Ledger decisions race", async () => {
    await pool.query(`UPDATE agents SET ledger_address = $1, ledger_revision = 1 WHERE id = $2`, [LEDGER.address.toLowerCase(), teamAgent.id]);
    const { approval } = await request(teamAgent, "req-both", ["org_owner", "ledger"]);
    const results = await Promise.allSettled([
      decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: await sign(OWNER, approval) }),
      decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "ledger", signature: await sign(LEDGER, approval) }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
  });

  it("reserves a grant for exactly one request and consumes it once", async () => {
    const { approval } = await request(teamAgent, "req-grant");
    await decideAgentApproval(deps, approval.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: await sign(OWNER, approval) });
    const claims = await Promise.all(["request-a", "request-b"].map((id) => approvals.claimGrant(teamAgent.id, "req-grant", 1, id)));
    const winner = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await approvals.claimGrant(teamAgent.id, "req-other", 1, "request-c")).toBeNull();
    // Proven unpaid: the grant returns for a retry of the same request.
    expect(await approvals.finishGrant(winner.id, winner.reservedRequestId!, "approved")).toMatchObject({ state: "approved", reservedRequestId: null });
    const retry = await approvals.claimGrant(teamAgent.id, "req-grant", 1, "request-d");
    expect(await approvals.finishGrant(retry!.id, "request-d", "consumed")).toMatchObject({ state: "consumed" });
    expect(await approvals.claimGrant(teamAgent.id, "req-grant", 1, "request-e")).toBeNull();
    // Expired grants cannot be claimed.
    const { approval: late } = await request(teamAgent, "req-late");
    await decideAgentApproval(deps, late.id, { identity: owner }, { decision: "approve", method: "org_owner", signature: await sign(OWNER, late) });
    expect(await approvals.claimGrant(teamAgent.id, "req-late", 1, "request-f", Date.now() + GRANT_TTL_MS + 1000)).toBeNull();
    expect(await approvals.cancelOpen({ agentId: teamAgent.id })).toBe(1);
    expect((await approvals.get(late.id))?.state).toBe("cancelled");
  });
});
