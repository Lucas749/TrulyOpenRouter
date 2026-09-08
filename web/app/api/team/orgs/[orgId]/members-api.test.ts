import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { addMember, approvalMessage, ensureOrg, memberActionMessage } from "../../../../../lib/members";
import { GET as listMembers, POST as addMemberRoute } from "./members/route";
import { PATCH as patchMember, DELETE as removeMemberRoute } from "./members/[did]/route";
import { GET as listRequests, POST as createRequestRoute } from "./requests/route";
import { POST as decideRoute } from "./requests/[id]/route";

const OWNER = privateKeyToAccount(generatePrivateKey());
const MEMBER = privateKeyToAccount(generatePrivateKey());
const MANAGER = privateKeyToAccount(generatePrivateKey());
const ORG = "org-test";

function owner() {
  return { did: "did:owner", walletAddress: OWNER.address, role: "owner" as const };
}

// NOTE: the message binds the EFFECTIVE role. Clients GET members first:
// empty list -> founding owner flow -> sign role "owner". Strict on purpose.
async function signedAdd(did: string, wallet: string, role = "member", allowance?: number) {
  const expires = Date.now() + 300_000;
  const message = memberActionMessage("member-add", { orgId: ORG, did, wallet, role }, expires);
  const signature = await OWNER.signMessage({ message });
  return { member: { did, walletAddress: wallet, role, allowanceCredits: allowance }, signature, message, signerWallet: OWNER.address };
}

beforeEach(async () => {
  process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-route-"));
  const { resetMembersDb } = await import("../../../../../lib/db-test");
  await resetMembersDb(["org-test"]);
  process.env.GATEWAY_ADMIN_TOKEN = "route-test-token";
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/api/admin/caps")) return { ok: true, json: async () => ({}) } as any;
      if (u.includes("/api/usage/")) return { ok: true, json: async () => ({ spent: 30 }) } as any;
      throw new Error(`unexpected fetch ${u} ${init?.method}`);
    }) as any,
  );
});

describe("members routes", () => {
  it("bootstraps the founding owner, then owner-gates further adds", async () => {
    await ensureOrg(ORG);
    const first = await signedAdd("did:owner", OWNER.address, "owner"); // empty org -> founding owner flow
    const r1 = await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(first) }), { params: Promise.resolve({ orgId: ORG }) });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as any).bootstrappedOwner).toBe(true);

    // non-owner signature rejected
    const rogueMsg = memberActionMessage("member-add", { orgId: ORG, did: "did:rogue", wallet: MEMBER.address, role: "member" }, Date.now() + 300_000);
    const rogue = await MEMBER.signMessage({ message: rogueMsg });
    const r2 = await addMemberRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ member: { did: "did:rogue", walletAddress: MEMBER.address }, signature: rogue, message: rogueMsg, signerWallet: MEMBER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(r2.status).toBe(403);

    // owner adds member with allowance
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    (add.member as any).keyPrefix = "prefixm1abcd";
    const r3 = await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(add) }), { params: Promise.resolve({ orgId: ORG }) });
    expect(r3.status).toBe(200);

    // list shows resolved caps + live spend
    const list = await listMembers(new Request("http://x"), { params: Promise.resolve({ orgId: ORG }) });
    const data: any = await list.json();
    expect(data.members).toHaveLength(2);
    const m1 = data.members.find((m: any) => m.did === "did:m1");
    expect(m1.effectiveCredits).toBe(100);
    expect(m1.spentCredits).toBe(30);
  });

  it("sets the org default (owner-signed)", async () => {
    await ensureOrg(ORG);
    const first = await signedAdd("did:owner", OWNER.address, "owner");
    await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(first) }), { params: Promise.resolve({ orgId: ORG }) });

    const expires = Date.now() + 300_000;
    const msg = memberActionMessage("org-set-default", { orgId: ORG, default: "500" }, expires);
    const sig = await OWNER.signMessage({ message: msg });
    const ok = await addMemberRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ setDefault: 500, signature: sig, message: msg, signerWallet: OWNER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).defaultAllowanceCredits).toBe(500);

    const rogueMsg = memberActionMessage("org-set-default", { orgId: ORG, default: "1" }, expires);
    const rogue = await MEMBER.signMessage({ message: rogueMsg });
    const denied = await addMemberRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ setDefault: 1, signature: rogue, message: rogueMsg, signerWallet: MEMBER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(denied.status).toBe(403);
  });

  it("invites by wallet alone (did defaults, login matches by wallet)", async () => {
    const first = await signedAdd("did:owner", OWNER.address, "owner");
    await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(first) }), { params: Promise.resolve({ orgId: ORG }) });
    const expires = Date.now() + 300_000;
    const did = `wallet:${MEMBER.address.toLowerCase()}`;
    const msg = memberActionMessage("member-add", { orgId: ORG, did, wallet: MEMBER.address, role: "member" }, expires);
    const sig = await OWNER.signMessage({ message: msg });
    const r = await addMemberRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ member: { walletAddress: MEMBER.address }, signature: sig, message: msg, signerWallet: OWNER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).member.did).toBe(did);
  });

  it("enforces prescoped manager powers (invite+allowance+decide, nothing else)", async () => {
    ensureOrg(ORG);
    const first = await signedAdd("did:owner", OWNER.address, "owner");
    await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(first) }), { params: Promise.resolve({ orgId: ORG }) });
    // Owner invites a manager.
    const mgr = await signedAdd("did:mgr", MANAGER.address, "manager");
    const mgrRes = await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(mgr) }), { params: Promise.resolve({ orgId: ORG }) });
    expect(mgrRes.status).toBe(200);
    // Owner invites a plain member for the manager to manage.
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    (add.member as any).keyPrefix = "prefixm1abcd";
    await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(add) }), { params: Promise.resolve({ orgId: ORG }) });

    const mgrSigned = async (action: string, bind: Record<string, string>) => {
      const message = memberActionMessage(action, bind, Date.now() + 300_000);
      return { message, signature: await MANAGER.signMessage({ message }), signerWallet: MANAGER.address };
    };
    // Manager sets allowance -> 200.
    const setMsg = await mgrSigned("member-set", { orgId: ORG, did: "did:m1" });
    const patched = await patchMember(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ allowanceCredits: 250, ...setMsg }) }),
      { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) },
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).member.allowanceCredits).toBe(250);
    // Manager invites a member -> 200.
    const invMsg = memberActionMessage("member-add", { orgId: ORG, did: "did:m2", wallet: MEMBER.address, role: "member" }, Date.now() + 300_000);
    const invited = await addMemberRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ member: { did: "did:m2", walletAddress: MEMBER.address, role: "member" }, signature: await MANAGER.signMessage({ message: invMsg }), message: invMsg, signerWallet: MANAGER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(invited.status).toBe(200);
    // Manager mints an owner -> 403.
    const escMsg = memberActionMessage("member-add", { orgId: ORG, did: "did:evil", wallet: MEMBER.address, role: "owner" }, Date.now() + 300_000);
    const esc = await addMemberRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ member: { did: "did:evil", walletAddress: MEMBER.address, role: "owner" }, signature: await MANAGER.signMessage({ message: escMsg }), message: escMsg, signerWallet: MANAGER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(esc.status).toBe(403);
    // Manager removes -> 403. Manager decides requests -> tested below via decide route shape.
    const rmMsg = await mgrSigned("member-remove", { orgId: ORG, did: "did:m1" });
    const removed = await removeMemberRoute(
      new Request("http://x", { method: "DELETE", body: JSON.stringify(rmMsg) }),
      { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) },
    );
    expect(removed.status).toBe(403);
    // Plain member sets allowance -> 403.
    const memMsg = memberActionMessage("member-set", { orgId: ORG, did: "did:m1" }, Date.now() + 300_000);
    const memSig = await MEMBER.signMessage({ message: memMsg });
    const memSet = await patchMember(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ allowanceCredits: 5, signature: memSig, message: memMsg, signerWallet: MEMBER.address }) }),
      { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) },
    );
    expect(memSet.status).toBe(403);
    // Manager changes a role -> 403 (owner-only).
    const roleMsg = await mgrSigned("member-set", { orgId: ORG, did: "did:m1" });
    const roleCh = await patchMember(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ role: "manager", ...roleMsg }) }),
      { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) },
    );
    expect(roleCh.status).toBe(403);
    // Manager decides an increase request -> 200, cap applied.
    const reqMsg = memberActionMessage("increase-request", { orgId: ORG, memberDid: "did:m1", amountCredits: "300" }, Date.now() + 300_000);
    const reqSig = await MEMBER.signMessage({ message: reqMsg });
    const created = await createRequestRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ memberDid: "did:m1", amountCredits: 300, signature: reqSig, message: reqMsg, signerWallet: MEMBER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(created.status).toBe(200);
    const req = ((await created.json()) as any).request;
    const decMsg = approvalMessage(req, "approve", Date.now() + 300_000);
    const decSig = await MANAGER.signMessage({ message: decMsg });
    const decided = await decideRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ decision: "approve", signerWallet: MANAGER.address, signature: decSig, message: decMsg }) }),
      { params: Promise.resolve({ orgId: ORG, id: req.id }) },
    );
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as any).request.status).toBe("approved");
  });

  it("edits allowance (sync-first) and removes members", async () => {
    await ensureOrg(ORG);
    const first = await signedAdd("did:owner", OWNER.address, "owner");
    await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(first) }), { params: Promise.resolve({ orgId: ORG }) });
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    (add.member as any).keyPrefix = "prefixm1abcd";
    await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(add) }), { params: Promise.resolve({ orgId: ORG }) });

    const expires = Date.now() + 300_000;
    const setMsg = memberActionMessage("member-set", { orgId: ORG, did: "did:m1" }, expires);
    const setSig = await OWNER.signMessage({ message: setMsg });
    const patched = await patchMember(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ allowanceCredits: 250, signature: setSig, message: setMsg, signerWallet: OWNER.address }) }),
      { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) },
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).member.allowanceCredits).toBe(250);

    const rmMsg = memberActionMessage("member-remove", { orgId: ORG, did: "did:m1" }, expires);
    const rmSig = await OWNER.signMessage({ message: rmMsg });
    const removed = await removeMemberRoute(
      new Request("http://x", { method: "DELETE", body: JSON.stringify({ signature: rmSig, message: rmMsg, signerWallet: OWNER.address }) }),
      { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) },
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as any).member.status).toBe("removed");
  });
});

describe("requests routes", () => {
  it("member requests, owner approves with wallet signature, cap applies", async () => {
    await ensureOrg(ORG);
    const first = await signedAdd("did:owner", OWNER.address, "owner");
    await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(first) }), { params: Promise.resolve({ orgId: ORG }) });
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    (add.member as any).keyPrefix = "prefixm1abcd";
    await addMemberRoute(new Request("http://x", { method: "POST", body: JSON.stringify(add) }), { params: Promise.resolve({ orgId: ORG }) });

    // member-signed increase request
    const expires = Date.now() + 300_000;
    const reqMsg = memberActionMessage("increase-request", { orgId: ORG, memberDid: "did:m1", amountCredits: "400" }, expires);
    const reqSig = await MEMBER.signMessage({ message: reqMsg });
    const created = await createRequestRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ memberDid: "did:m1", amountCredits: 400, signature: reqSig, message: reqMsg, signerWallet: MEMBER.address }) }),
      { params: Promise.resolve({ orgId: ORG }) },
    );
    expect(created.status).toBe(200);
    const reqId = ((await created.json()) as any).request.id;

    const inbox = await listRequests(new Request("http://x/api?status=pending"), { params: Promise.resolve({ orgId: ORG }) });
    expect(((await inbox.json()) as any).data).toHaveLength(1);

    // owner approves with wallet signature over the canonical decision message
    const decExpires = Date.now() + 300_000;
    const decMsg = approvalMessage({ id: reqId, orgId: ORG, memberDid: "did:m1", amountCredits: 400 }, "approve", decExpires);
    const decSig = await OWNER.signMessage({ message: decMsg });
    const decided = await decideRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ decision: "approve", signature: decSig, message: decMsg, signerWallet: OWNER.address }) }),
      { params: Promise.resolve({ orgId: ORG, id: reqId }) },
    );
    expect(decided.status).toBe(200);
    const body: any = await decided.json();
    expect(body.request.status).toBe("approved");
    expect(body.request.decisionSigner).toBe(OWNER.address);
    expect(body.gatewaySynced).toBe(true);
  });
});
