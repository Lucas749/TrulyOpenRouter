import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const sessions = vi.hoisted(() => new Map<string, { userId: string; wallets: string[] }>());
vi.mock("@privy-io/server-auth", () => ({
  PrivyClient: class {
    async verifyAuthToken(token: string) {
      const s = sessions.get(token);
      if (!s) throw new Error("invalid token");
      return { userId: s.userId };
    }
    async getUser(userId: string) {
      const s = [...sessions.values()].find((x) => x.userId === userId);
      return { linkedAccounts: (s?.wallets ?? []).map((address) => ({ type: "wallet", chainType: "ethereum", address })) };
    }
  },
}));

import { addMember, decideRuleChange, ensureOrg, getRules, listRuleChanges, memberActionMessage, proposeRuleChange, validateRulePayload } from "../../../../../../lib/members";
import { stableJson } from "../../../../../../lib/member-messages";
import { GET as listRules, POST as proposeRoute } from "./route";
import { POST as decideRoute } from "./changes/[id]/route";
import { POST as setRoute } from "./set/route";

const OWNER = privateKeyToAccount(generatePrivateKey());
const MEMBER = privateKeyToAccount(generatePrivateKey());
const ORG = "org-rules";

function req(token: string | null, body?: unknown) {
  return new Request("http://x", { method: body === undefined ? "GET" : "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function ownerSigned(action: string, fields: Record<string, string>) {
  const message = memberActionMessage(action, fields, Date.now() + 300_000);
  return { message, signature: await OWNER.signMessage({ message }), signerWallet: OWNER.address };
}

beforeEach(async () => {
  process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-rules-"));
  const { resetMembersDb } = await import("../../../../../../lib/db-test");
  await resetMembersDb([ORG]);
  process.env.GATEWAY_ADMIN_TOKEN = "rules-test-token";
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "app";
  process.env.PRIVY_APP_SECRET = "secret";
  sessions.clear();
  sessions.set("owner", { userId: "did:owner", wallets: [OWNER.address.toLowerCase()] });
  sessions.set("member", { userId: "did:m1", wallets: [MEMBER.address.toLowerCase()] });
  sessions.set("stranger", { userId: "did:stranger", wallets: [] });
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any));
});

describe("org rules", () => {
  it("validates the full rule catalog", () => {
    validateRulePayload("regions", { regions: ["us-oregon", "eu-west"] });
    validateRulePayload("regions", { regions: null });
    validateRulePayload("verified", { only: true });
    validateRulePayload("verified", { only: false });
    validateRulePayload("rate_limit", { perMin: 20 });
    validateRulePayload("rate_limit", { perMin: null });
    validateRulePayload("hosts", { hosts: ["0x0000000000000000000000000000000000000001"] });
    validateRulePayload("hosts", { hosts: null });
    expect(() => validateRulePayload("regions", { regions: ["USA!!"] })).toThrow("cc-name slugs");
    expect(() => validateRulePayload("regions", { regions: "us-oregon" })).toThrow("cc-name");
    expect(() => validateRulePayload("verified", { only: "yes" })).toThrow("true or false");
    expect(() => validateRulePayload("rate_limit", { perMin: 0 })).toThrow("positive integer");
    expect(() => validateRulePayload("rate_limit", { perMin: 1.5 })).toThrow("positive integer");
    expect(() => validateRulePayload("hosts", { hosts: ["nope"] })).toThrow("0x host addresses");
  });

  it("validates payloads per kind", () => {
    validateRulePayload("daily_cap", { credits: 100 });
    validateRulePayload("daily_cap", { credits: null });
    validateRulePayload("models", { models: ["m1"] });
    validateRulePayload("models", { models: null });
    validateRulePayload("per_tx_cap", { usd: 25 });
    expect(() => validateRulePayload("nope", {})).toThrow("unknown rule kind");
    expect(() => validateRulePayload("daily_cap", { credits: -1 })).toThrow("non-negative");
    expect(() => validateRulePayload("models", { models: "m1" })).toThrow("string array");
    expect(() => validateRulePayload("per_tx_cap", { usd: 0 })).toThrow("positive");
    expect(stableJson({ b: 1, a: { z: 3, y: 2 } })).toBe('{"a":{"y":2,"z":3},"b":1}');
  });

  it("proposes (owner-signed), decides (owner-only), applies on approve", async () => {
    await ensureOrg(ORG);
    // bootstrap owner via direct store (route-tested elsewhere)
    await addMember(ORG, { did: "did:owner", walletAddress: OWNER.address, role: "owner" });
    const params = { params: Promise.resolve({ orgId: ORG }) };
    const payload = { credits: 500 };
    const sig = await ownerSigned("rule-propose", { orgId: ORG, kind: "daily_cap", payload: stableJson(payload) });
    const created = await proposeRoute(req("owner", { kind: "daily_cap", payload, memberDid: "did:owner", ...sig }), params);
    expect(created.status).toBe(200);
    const change = ((await created.json()) as any).change;
    expect(change.status).toBe("pending");
    expect((await listRules(req("owner"), params)).status).toBe(200);
    expect((await listRules(req(null), params)).status).toBe(401);
    expect((await listRules(req("stranger"), params)).status).toBe(404);

    // member (non-owner/manager) cannot propose
    await addMember(ORG, { did: "did:m1", walletAddress: MEMBER.address, role: "member" });
    const memMsg = memberActionMessage("rule-propose", { orgId: ORG, kind: "daily_cap", payload: stableJson(payload) }, Date.now() + 300_000);
    const memSig = await MEMBER.signMessage({ message: memMsg });
    const denied = await proposeRoute(req("member", { kind: "daily_cap", payload, memberDid: "did:m1", signature: memSig, message: memMsg, signerWallet: MEMBER.address }), params);
    expect(denied.status).toBe(403);

    // owner denies first (history), then approves a fresh one (applies)
    const { ruleDecisionMessage } = await import("../../../../../../lib/member-messages");
    const decision = (id: string) => ({ params: Promise.resolve({ orgId: ORG, id }) });
    const denyMsg = ruleDecisionMessage({ id: change.id, orgId: ORG, kind: "daily_cap", payloadJson: stableJson(payload) }, "deny", Date.now() + 300_000);
    const denySig = await OWNER.signMessage({ message: denyMsg });
    const d1 = await decideRoute(req("owner", { decision: "deny", signerWallet: OWNER.address, signature: denySig, message: denyMsg }), decision(change.id));
    expect(d1.status).toBe(200);
    expect(((await d1.json()) as any).change.status).toBe("denied");
    expect((await getRules(ORG)).dailyCapCredits).toBeUndefined();

    const sig2 = await ownerSigned("rule-propose", { orgId: ORG, kind: "daily_cap", payload: stableJson(payload) });
    const created2 = await proposeRoute(req("owner", { kind: "daily_cap", payload, memberDid: "did:owner", ...sig2 }), params);
    const change2 = ((await created2.json()) as any).change;
    const okMsg = ruleDecisionMessage({ id: change2.id, orgId: ORG, kind: "daily_cap", payloadJson: stableJson(payload) }, "approve", Date.now() + 300_000);
    const okSig = await OWNER.signMessage({ message: okMsg });
    // The owner's signature presented under another login is refused.
    expect((await decideRoute(req("member", { decision: "approve", signerWallet: OWNER.address, signature: okSig, message: okMsg }), decision(change2.id))).status).toBe(403);
    const d2 = await decideRoute(req("owner", { decision: "approve", signerWallet: OWNER.address, signature: okSig, message: okMsg }), decision(change2.id));
    const out: any = await d2.json();
    expect(d2.status).toBe(200);
    expect(out.change.status).toBe("approved");
    expect(out.gatewaySynced).toBe(true);
    expect((await getRules(ORG)).dailyCapCredits).toBe(500);

    // replay a decided request -> 401, forged signer -> 401
    const replay = await decideRoute(req("owner", { decision: "approve", signerWallet: OWNER.address, signature: okSig, message: okMsg }), decision(change2.id));
    expect(replay.status).toBe(401);
  });

  it("owner sets directly in one signature (manager gets 403)", async () => {
    await ensureOrg(ORG);
    await addMember(ORG, { did: "did:owner", walletAddress: OWNER.address, role: "owner" });
    await addMember(ORG, { did: "did:mgr", walletAddress: MEMBER.address, role: "manager" });
    const params = { params: Promise.resolve({ orgId: ORG }) };
    const payload = { credits: 111 };
    const msgLines = (e: number) => ["tor-team:rule-set", `expires: ${e}`, "kind: daily_cap", `orgId: ${ORG}`, `payload: ${stableJson(payload)}`].join("\n");
    const exp = Date.now() + 300_000;
    const msg = msgLines(exp);
    const sig = await OWNER.signMessage({ message: msg });
    const ok = await setRoute(req("owner", { kind: "daily_cap", payload, memberDid: "did:owner", signature: sig, message: msg, signerWallet: OWNER.address }), params);
    expect(ok.status).toBe(200);
    const out: any = await ok.json();
    expect(out.rules.dailyCapCredits).toBe(111);
    expect(out.gatewaySynced).toBe(true);
    expect((await getRules(ORG)).dailyCapCredits).toBe(111);
    // manager direct-set -> 403 (they propose instead)
    const mmsg = msgLines(Date.now() + 300_000);
    const msig = await MEMBER.signMessage({ message: mmsg });
    const denied = await setRoute(req("member", { kind: "daily_cap", payload, memberDid: "did:mgr", signature: msig, message: mmsg, signerWallet: MEMBER.address }), params);
    expect(denied.status).toBe(403);
    // tampered payload -> 400 (signature binds exact bytes)
    const evil = await setRoute(req("owner", { kind: "daily_cap", payload: { credits: 999 }, memberDid: "did:owner", signature: sig, message: msg, signerWallet: OWNER.address }), params);
    expect(evil.status).toBe(400);
  });

  it("decideRuleChange validates directly", async () => {
    await ensureOrg(ORG);
    await expect(decideRuleChange("nope", "approve", "d", OWNER.address, "0x", "m")).rejects.toThrow("not found");
    const r = await proposeRuleChange(ORG, "models", { models: ["m1"] }, "did:owner");
    expect((await listRuleChanges(ORG, "pending")).map((x) => x.id)).toContain(r.id);
  });
});
