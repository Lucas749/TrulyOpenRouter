import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type GatewayOptions } from "../src/index.js";
import { MemoryOrgRules } from "../src/orgrules.js";
import { MemoryReceiptLog } from "../src/receipts.js";
import { SubscriberError } from "../src/subscriber.js";
import type { Team, TeamMember } from "../src/teams.js";

const TEAM_WALLET = `0x${"7e".repeat(20)}`;
const HOST = `0x${"22".repeat(20)}` as const;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const team = (state: Team["state"]): Team => ({
  orgId: "org-1", name: "Acme", walletId: "wallet-1", walletAddress: TEAM_WALLET, quorumId: "q", policyId: "p", approverUserId: "did:privy:owner",
  payoutRecipients: [], state, defaultAllowanceCredits: null, membershipRevision: 1,
});
const member: TeamMember = { orgId: "org-1", did: "did:privy:member", wallet: null, email: null, role: "member", status: "active", allowanceCredits: null };

async function setup(overrides: GatewayOptions = {}, teamState: Team["state"] = "active") {
  const served = vi.fn();
  const upstream = express().use(express.json());
  upstream.post("/v1/chat/completions", (_req, res) => {
    served();
    res.json({ choices: [{ message: { content: "team answer" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  });
  const endpoint = listen(upstream);
  const settle = vi.fn(async () => "0xteamdebit");
  const receipts = new MemoryReceiptLog();
  const subscriptionCredits = vi.fn(async () => 10n);
  const sessions: Record<string, { userId: string; wallets: `0x${string}`[] }> = {
    "member-session": { userId: "did:privy:member", wallets: [] },
    "outsider-session": { userId: "did:privy:outsider", wallets: [`0x${"99".repeat(20)}`] },
  };
  const teams = {
    memberFor: vi.fn(async (orgId: string, identity: { userId: string }) => (orgId === "org-1" && identity.userId === member.did ? member : null)),
    team: vi.fn(async (orgId: string) => (orgId === "org-1" ? team(teamState) : null)),
  };
  const base = listen(createApp({
    verifySession: async (token) => {
      if (!sessions[token]) throw new SubscriberError(401, "authentication_required", "Invalid session");
      return sessions[token];
    },
    // The personal wallet path must never be consulted for a team-billed request.
    verifySubscriber: async () => {
      throw new SubscriberError(500, "unexpected", "personal wallet path used");
    },
    teams: teams as any,
    subscriptionCredits,
    settle,
    receipts,
    fetchHosts: async () => [{ address: HOST, modelId: "qwen", modelDigest: "0xabc", endpoint, pricePerReq: 100_000n, pricePer1kTokens: 100_000n, active: true, stake: 1n, lastHeartbeat: Date.now() }],
    ...overrides,
  }));
  const chat = (token: string | undefined, body: Record<string, unknown> = { tor_team: "org-1" }) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model: "qwen", messages: [{ role: "user", content: "hello" }], ...body }),
    });
  return { chat, served, settle, receipts, subscriptionCredits, teams };
}

describe("team billing", () => {
  it("bills an active member against the team wallet without a personal subscription", async () => {
    const ctx = await setup();
    const response = await ctx.chat("member-session", { tor_team: "org-1", userHandle: `0x${"99".repeat(20)}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tor_settled: true, choices: [{ message: { content: "team answer" } }] });
    expect(ctx.subscriptionCredits.mock.calls).toEqual([[TEAM_WALLET]]);
    expect((ctx.settle.mock.calls[0] as unknown[])[0]).toBe(TEAM_WALLET);
    expect((await ctx.receipts.list())[0]).toMatchObject({
      user: "member:org-1:did:privy:member", team: "org-1", member: "did:privy:member", payer: TEAM_WALLET, debitTx: "0xteamdebit",
    });
  });

  it("rejects missing sessions, outsiders, other teams, and inactive team wallets before reading credits", async () => {
    const ctx = await setup();
    expect((await ctx.chat(undefined)).status).toBe(401);
    expect((await ctx.chat("outsider-session")).status).toBe(403);
    expect((await ctx.chat("member-session", { tor_team: "org-2" })).status).toBe(403);
    expect(ctx.subscriptionCredits).not.toHaveBeenCalled();
    expect(ctx.served).not.toHaveBeenCalled();
    const pending = await setup({}, "pending");
    const inactive = await pending.chat("member-session");
    expect(inactive.status).toBe(409);
    expect((await inactive.json()).error.type).toBe("team_wallet_inactive");
    expect(pending.subscriptionCredits).not.toHaveBeenCalled();
    expect(pending.served).not.toHaveBeenCalled();
  });

  it("fails closed when team billing is not configured", async () => {
    for (const overrides of [{ teams: undefined }, { verifySession: undefined }]) {
      const ctx = await setup(overrides);
      expect((await ctx.chat("member-session")).status).toBe(503);
      expect(ctx.served).not.toHaveBeenCalled();
    }
  });

  it("holds one in-flight payment per team wallet", async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const inFlight = new Promise<void>((r) => { started = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const ctx = await setup({ settle: async () => { started(); await gate; return "0xtx"; } });
    const first = ctx.chat("member-session");
    await inFlight;
    const second = await ctx.chat("member-session");
    expect(second.status).toBe(409);
    expect((await second.json()).error.type).toBe("billing_pending");
    release();
    expect((await first).status).toBe(200);
  });

  it("applies the billed team's rules and daily ceiling to team spend", async () => {
    const orgRules = new MemoryOrgRules();
    await orgRules.set({ orgId: "org-1", dailyCapCredits: 1, allowedModels: null, allowedRegions: null, requireVerified: false, rateLimitPerMin: null, pinnedHosts: null, handles: [] });
    const ctx = await setup({ orgRules });
    expect((await ctx.chat("member-session")).status).toBe(200);
    const capped = await ctx.chat("member-session");
    expect(capped.status).toBe(429);
    await orgRules.set({ orgId: "org-1", dailyCapCredits: null, allowedModels: ["another-model"], allowedRegions: null, requireVerified: false, rateLimitPerMin: null, pinnedHosts: null, handles: [] });
    const denied = await ctx.chat("member-session");
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.type).toBe("org_policy");
    expect(ctx.served).toHaveBeenCalledTimes(1);
  });
});
