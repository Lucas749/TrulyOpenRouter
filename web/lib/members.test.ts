import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  addMember,
  approvalMessage,
  createIncreaseRequest,
  decideRequest,
  effectiveAllowance,
  ensureOrg,
  getRequest,
  listRequests,
  periodStartFor,
  removeMember,
  setMemberAllowance,
  setOrgDefault,
  verifyApprovalSignature,
} from "../lib/members";

const OWNER = privateKeyToAccount(generatePrivateKey()); // fresh each run — never hand-type keys
const MEMBER_KEY = generatePrivateKey();
const MEMBER = privateKeyToAccount(MEMBER_KEY);
const MEMBER_WALLET = MEMBER.address;

beforeEach(() => {
  process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-members-"));
});

describe("members store", () => {
  it("adds members, prevents dupes and last-owner removal", () => {
    ensureOrg("org1");
    addMember("org1", { did: "did:o1", walletAddress: OWNER.address, role: "owner" });
    addMember("org1", { did: "did:m1", walletAddress: MEMBER_WALLET, role: "member", allowanceCredits: 100 });
    expect(() => addMember("org1", { did: "did:m1", walletAddress: MEMBER_WALLET, role: "member" })).toThrow("already active");
    expect(() => removeMember("org1", "did:o1")).toThrow("last owner");
    const m = removeMember("org1", "did:m1");
    expect(m.status).toBe("removed");
    // re-invite revives
    const m2 = addMember("org1", { did: "did:m1", walletAddress: MEMBER_WALLET, role: "member" });
    expect(m2.status).toBe("active");
  });

  it("resolves the Anthropic-style fallback chain", () => {
    ensureOrg("org1");
    expect(effectiveAllowance({ orgId: "org1", periodDays: 30, members: [] }, "did:ghost")).toBe(0); // unknown = deny
    addMember("org1", { did: "did:o1", walletAddress: OWNER.address, role: "owner" });
    addMember("org1", { did: "did:m1", walletAddress: MEMBER_WALLET, role: "member" });
    const meta = ensureOrg("org1");
    expect(effectiveAllowance(meta, "did:m1")).toBe(Infinity); // no default = unlimited
    setOrgDefault("org1", 500);
    expect(effectiveAllowance(ensureOrg("org1"), "did:m1")).toBe(500); // inherits org default
    setMemberAllowance("org1", "did:m1", 100);
    expect(effectiveAllowance(ensureOrg("org1"), "did:m1")).toBe(100); // override wins
    setMemberAllowance("org1", "did:m1", undefined);
    expect(effectiveAllowance(ensureOrg("org1"), "did:m1")).toBe(500); // back to default
    removeMember("org1", "did:m1");
    expect(effectiveAllowance(ensureOrg("org1"), "did:m1")).toBe(0); // removed = deny
  });

  it("rolls allowance periods", () => {
    const meta = ensureOrg("org1");
    meta.periodDays = 30;
    addMember("org1", { did: "did:m1", walletAddress: MEMBER_WALLET, role: "member", periodStart: Date.now() - 31 * 86_400_000 });
    const rolled = periodStartFor(ensureOrg("org1"), "did:m1", Date.now());
    expect(rolled).toBeGreaterThan(Date.now() - 1000); // new period starts now
  });
});

describe("increase requests + wallet-signed decisions", () => {
  async function setup() {
    ensureOrg("org1");
    addMember("org1", { did: "did:o1", walletAddress: OWNER.address, role: "owner" });
    addMember("org1", { did: "did:m1", walletAddress: MEMBER_WALLET, role: "member", allowanceCredits: 100 });
    return createIncreaseRequest("org1", "did:m1", 400);
  }

  it("approves with the owner wallet signature and applies the cap", async () => {
    const r = await setup();
    expect(getRequest(r.id)?.status).toBe("pending");
    expect(listRequests("org1", "pending")).toHaveLength(1);
    const expires = Date.now() + 300_000;
    const message = approvalMessage(r, "approve", expires);
    const signature = await OWNER.signMessage({ message });
    const decided = await decideRequest(r.id, "approve", "did:o1", OWNER.address, signature, message);
    expect(decided.status).toBe("approved");
    expect(decided.decisionSigner).toBe(OWNER.address);
    expect(effectiveAllowance(ensureOrg("org1"), "did:m1")).toBe(400);
  });

  it("rejects wrong-wallet, mismatched, and expired signatures", async () => {
    const r = await setup();
    const expires = Date.now() + 300_000;
    const message = approvalMessage(r, "approve", expires);
    // wrong wallet signed
    const rogue = await MEMBER.signMessage({ message });
    await expect(decideRequest(r.id, "approve", "did:o1", OWNER.address, rogue, message)).rejects.toThrow("not from the recorded owner");
    // message/action mismatch
    const denySig = await OWNER.signMessage({ message: approvalMessage(r, "deny", expires) });
    await expect(decideRequest(r.id, "approve", "did:o1", OWNER.address, denySig, approvalMessage(r, "approve", expires))).rejects.toThrow();
    // expired
    const oldMsg = approvalMessage(r, "approve", Date.now() - 1000);
    const oldSig = await OWNER.signMessage({ message: oldMsg });
    await expect(decideRequest(r.id, "approve", "did:o1", OWNER.address, oldSig, oldMsg)).rejects.toThrow("expired");
    // deny path works and leaves cap alone
    const denyMsg = approvalMessage(r, "deny", expires);
    const denied = await decideRequest(r.id, "deny", "did:o1", OWNER.address, await OWNER.signMessage({ message: denyMsg }), denyMsg);
    expect(denied.status).toBe("denied");
    expect(effectiveAllowance(ensureOrg("org1"), "did:m1")).toBe(100);
  });

  it("verifyApprovalSignature roundtrips EIP-191", async () => {
    const sig = await OWNER.signMessage({ message: "hello tor" });
    expect(await verifyApprovalSignature("hello tor", sig, OWNER.address)).toBe(true);
    expect(await verifyApprovalSignature("hello tor", sig, MEMBER_WALLET)).toBe(false);
  });
});
