import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { addMember, decideRuleChange, ensureOrg, getRules, listRuleChanges, memberActionMessage, proposeRuleChange, validateRulePayload } from "../../../../../../lib/members";
import { stableJson } from "../../../../../../lib/member-messages";
import { GET as listRules, POST as proposeRoute } from "./route";
import { POST as decideRoute } from "./changes/[id]/route";

const OWNER = privateKeyToAccount(generatePrivateKey());
const MEMBER = privateKeyToAccount(generatePrivateKey());
const ORG = "org-rules";

async function ownerSigned(action: string, fields: Record<string, string>) {
  const message = memberActionMessage(action, fields, Date.now() + 300_000);
  return { message, signature: await OWNER.signMessage({ message }), signerWallet: OWNER.address };
}

beforeEach(async () => {
  process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-rules-"));
  const { resetMembersDb } = await import("../../../../../../lib/db-test");
  await resetMembersDb([ORG]);
  process.env.GATEWAY_ADMIN_TOKEN = "rules-test-token";
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as any));
});

describe("org rules", () => {
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
    const payload = { credits: 500 };
    const sig = await ownerSigned("rule-propose", { orgId: ORG, kind: "daily_cap", payload: stableJson(payload) });
    const created = await proposeRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "daily_cap", payload, memberDid: "did:owner", ...sig }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(created.status).toBe(200);
    const change = ((await created.json()) as any).change;
    expect(change.status).toBe("pending");
    expect((await listRules(new Request("http://x"), { params: Promise.resolve({ orgId: ORG }) })).status).toBe(200);

    // member (non-owner/manager) cannot propose
    await addMember(ORG, { did: "did:m1", walletAddress: MEMBER.address, role: "member" });
    const memMsg = memberActionMessage("rule-propose", { orgId: ORG, kind: "daily_cap", payload: stableJson(payload) }, Date.now() + 300_000);
    const memSig = await MEMBER.signMessage({ message: memMsg });
    const denied = await proposeRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "daily_cap", payload, memberDid: "did:m1", signature: memSig, message: memMsg, signerWallet: MEMBER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(denied.status).toBe(403);

    // owner denies first (history), then approves a fresh one (applies)
    const { ruleDecisionMessage } = await import("../../../../../../lib/member-messages");
    const denyMsg = ruleDecisionMessage({ id: change.id, orgId: ORG, kind: "daily_cap", payloadJson: stableJson(payload) }, "deny", Date.now() + 300_000);
    const denySig = await OWNER.signMessage({ message: denyMsg });
    const d1 = await decideRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ decision: "deny", signerWallet: OWNER.address, signature: denySig, message: denyMsg }) }),
      { params: Promise.resolve({ orgId: ORG, id: change.id }) },
    );
    expect(d1.status).toBe(200);
    expect(((await d1.json()) as any).change.status).toBe("denied");
    expect((await getRules(ORG)).dailyCapCredits).toBeUndefined();

    const sig2 = await ownerSigned("rule-propose", { orgId: ORG, kind: "daily_cap", payload: stableJson(payload) });
    const created2 = await proposeRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "daily_cap", payload, memberDid: "did:owner", ...sig2 }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    const change2 = ((await created2.json()) as any).change;
    const okMsg = ruleDecisionMessage({ id: change2.id, orgId: ORG, kind: "daily_cap", payloadJson: stableJson(payload) }, "approve", Date.now() + 300_000);
    const okSig = await OWNER.signMessage({ message: okMsg });
    const d2 = await decideRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ decision: "approve", signerWallet: OWNER.address, signature: okSig, message: okMsg }) }),
      { params: Promise.resolve({ orgId: ORG, id: change2.id }) },
    );
    const out: any = await d2.json();
    expect(d2.status).toBe(200);
    expect(out.change.status).toBe("approved");
    expect(out.gatewaySynced).toBe(true);
    expect((await getRules(ORG)).dailyCapCredits).toBe(500);

    // replay a decided request -> 401, forged signer -> 401
    const replay = await decideRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ decision: "approve", signerWallet: OWNER.address, signature: okSig, message: okMsg }) }),
      { params: Promise.resolve({ orgId: ORG, id: change2.id }) },
    );
    expect(replay.status).toBe(401);
  });

  it("decideRuleChange validates directly", async () => {
    await ensureOrg(ORG);
    await expect(decideRuleChange("nope", "approve", "d", OWNER.address, "0x", "m")).rejects.toThrow("not found");
    const r = await proposeRuleChange(ORG, "models", { models: ["m1"] }, "did:owner");
    expect((await listRuleChanges(ORG, "pending")).map((x) => x.id)).toContain(r.id);
  });
});
