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

import { approvalMessage, ensureOrg, getMember, memberActionMessage, setOrgCreator } from "../../../../../lib/members";
import { GET as listMembers, POST as addMemberRoute } from "./members/route";
import { PATCH as patchMember, DELETE as removeMemberRoute } from "./members/[did]/route";
import { GET as listRequests, POST as createRequestRoute } from "./requests/route";
import { POST as decideRoute } from "./requests/[id]/route";

const OWNER = privateKeyToAccount(generatePrivateKey());
const MEMBER = privateKeyToAccount(generatePrivateKey());
const MANAGER = privateKeyToAccount(generatePrivateKey());
const ORG = "org-test";

// Every team call carries a verified login; the signing wallet must be linked to it.
function req(token: string | null, method = "GET", body?: unknown, url = "http://x") {
  return new Request(url, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const org = { params: Promise.resolve({ orgId: ORG }) };

// NOTE: the message binds the EFFECTIVE role. Clients GET members first:
// empty list -> founding owner flow -> sign role "owner". Strict on purpose.
async function signedAdd(did: string, wallet: string, role = "member", allowance?: number) {
  const expires = Date.now() + 300_000;
  const message = memberActionMessage("member-add", { orgId: ORG, did, wallet, role }, expires);
  const signature = await OWNER.signMessage({ message });
  return { member: { did, walletAddress: wallet, role, allowanceCredits: allowance }, signature, message, signerWallet: OWNER.address };
}

async function foundOwner() {
  await ensureOrg(ORG);
  await setOrgCreator(ORG, OWNER.address);
  const first = await signedAdd("did:owner", OWNER.address, "owner");
  const r = await addMemberRoute(req("owner", "POST", first), org);
  expect(r.status).toBe(200);
  return r;
}

export const spendCapCalls: any[] = [];
// API keys the gateway knows, by prefix, with the login that issued each one.
const keyOwners: Record<string, string> = { prefixm1abcd: "did:m1", tor_sk_VICTM: "did:privy:victim" };
const teamSnapshots: any[] = [];
let failTeamSync = false;

beforeEach(async () => {
  teamSnapshots.length = 0;
  failTeamSync = false;
  process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-route-"));
  const { resetMembersDb } = await import("../../../../../lib/db-test");
  await resetMembersDb(["org-test"]);
  process.env.GATEWAY_ADMIN_TOKEN = "route-test-token";
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "app";
  process.env.PRIVY_APP_SECRET = "secret";
  sessions.clear();
  sessions.set("owner", { userId: "did:owner", wallets: [OWNER.address.toLowerCase()] });
  sessions.set("member", { userId: "did:m1", wallets: [MEMBER.address.toLowerCase()] });
  sessions.set("manager", { userId: "did:mgr", wallets: [MANAGER.address.toLowerCase()] });
  sessions.set("stranger", { userId: "did:stranger", wallets: ["0x0000000000000000000000000000000000009999"] });
  spendCapCalls.length = 0;
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes("/api/admin/keys/")) {
        const owner = keyOwners[decodeURIComponent(u.split("/api/admin/keys/")[1])];
        return owner
          ? ({ ok: true, status: 200, json: async () => ({ ownerUserId: owner, revoked: false }) } as any)
          : ({ ok: false, status: 404, text: async () => "unknown key", json: async () => ({}) } as any);
      }
      if (u.includes("/api/admin/caps")) return { ok: true, json: async () => ({}) } as any;
      if (u.includes("/api/admin/spend-caps")) {
        spendCapCalls.push(JSON.parse(String(init?.body ?? "{}")));
        return { ok: true, status: 200, json: async () => ({ targets: [], txs: {} }) } as any;
      }
      if (u.includes("/api/usage/")) return { ok: true, json: async () => ({ spent: 30 }) } as any;
      if (u.includes("/api/admin/teams/")) {
        if (failTeamSync) return { ok: false, status: 503, text: async () => "team store unavailable" } as any;
        teamSnapshots.push({ url: u, ...JSON.parse(String(init?.body ?? "{}")) });
        return { ok: true, status: 200, json: async () => ({ revision: teamSnapshots.length, changed: true, removed: [] }) } as any;
      }
      throw new Error(`unexpected fetch ${u} ${init?.method}`);
    }) as any,
  );
});

describe("members routes", () => {
  it("bootstraps the founding owner, then owner-gates further adds", async () => {
    const r1 = await foundOwner();
    expect(((await r1.json()) as any).bootstrappedOwner).toBe(true);

    // non-owner signature rejected
    const rogueMsg = memberActionMessage("member-add", { orgId: ORG, did: "did:rogue", wallet: MEMBER.address, role: "member" }, Date.now() + 300_000);
    const rogue = await MEMBER.signMessage({ message: rogueMsg });
    const r2 = await addMemberRoute(
      req("member", "POST", { member: { did: "did:rogue", walletAddress: MEMBER.address }, signature: rogue, message: rogueMsg, signerWallet: MEMBER.address }),
      org,
    );
    expect(r2.status).toBe(403);

    // owner adds member with allowance
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    (add.member as any).keyPrefix = "prefixm1abcd";
    const r3 = await addMemberRoute(req("owner", "POST", add), org);
    expect(r3.status).toBe(200);
    // onchain mirror: wallet + budget prefix capped at the effective allowance
    expect(((await r3.json()) as any).chainSynced).toBe("synced");
    expect(spendCapCalls.at(-1)).toMatchObject({ address: MEMBER.address, prefix: "prefixm1abcd", capCredits: 100, periodDays: 30 });

    // list shows resolved caps + live spend
    const list = await listMembers(req("member"), org);
    const data: any = await list.json();
    expect(data.members).toHaveLength(2);
    const m1 = data.members.find((m: any) => m.did === "did:m1");
    expect(m1.effectiveCredits).toBe(100);
    expect(m1.spentCredits).toBe(30);
  });

  it("requires a verified login, hides teams from outsiders, and binds signatures to the login", async () => {
    await foundOwner();
    expect((await listMembers(req(null), org)).status).toBe(401);
    expect((await listMembers(req("stranger"), org)).status).toBe(404);
    expect((await listRequests(req("stranger"), org)).status).toBe(404);
    // A valid owner signature replayed from another login is refused.
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    expect((await addMemberRoute(req("stranger", "POST", add), org)).status).toBe(403);
    expect((await addMemberRoute(req(null, "POST", add), org)).status).toBe(401);
  });

  it("mirrors membership to the gateway and revokes access there before storing a removal", async () => {
    await foundOwner();
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    const added = await addMemberRoute(req("owner", "POST", add), org);
    expect(((await added.json()) as any).teamSynced).toBe(true);
    expect(teamSnapshots.at(-1).url).toContain(`/api/admin/teams/${ORG}/snapshot`);
    expect(teamSnapshots.at(-1).members).toEqual(expect.arrayContaining([
      { did: "did:owner", wallet: OWNER.address, email: null, role: "owner", status: "active", allowanceCredits: null },
      { did: "did:m1", wallet: MEMBER.address, email: null, role: "member", status: "active", allowanceCredits: 100 },
    ]));
    const member = { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) };
    const remove = async () => {
      const message = memberActionMessage("member-remove", { orgId: ORG, did: "did:m1" }, Date.now() + 300_000);
      return removeMemberRoute(req("owner", "DELETE", { signature: await OWNER.signMessage({ message }), message, signerWallet: OWNER.address }), member);
    };
    // The gateway is unreachable: nothing is stored, the member stays active.
    failTeamSync = true;
    expect((await remove()).status).toBe(502);
    expect((await getMember(ORG, "did:m1"))?.status).toBe("active");
    failTeamSync = false;
    const before = teamSnapshots.length;
    expect((await remove()).status).toBe(200);
    // First push is the preview (removed on the gateway), then the stored state.
    expect(teamSnapshots[before].members.find((m: any) => m.did === "did:m1").status).toBe("removed");
    expect(teamSnapshots.at(-1).members.find((m: any) => m.did === "did:m1").status).toBe("removed");
    expect((await getMember(ORG, "did:m1"))?.status).toBe("removed");
  });

  it("only the verified creator can found an ownerless team", async () => {
    await ensureOrg(ORG);
    await setOrgCreator(ORG, OWNER.address);
    const expires = Date.now() + 300_000;
    const message = memberActionMessage("member-add", { orgId: ORG, did: "did:m1", wallet: MEMBER.address, role: "owner" }, expires);
    const signature = await MEMBER.signMessage({ message });
    const hijack = await addMemberRoute(
      req("member", "POST", { member: { did: "did:m1", walletAddress: MEMBER.address, role: "owner" }, signature, message, signerWallet: MEMBER.address }),
      org,
    );
    expect(hijack.status).toBe(403);
  });

  it("sets the org default (owner-signed)", async () => {
    await foundOwner();
    const expires = Date.now() + 300_000;
    const msg = memberActionMessage("org-set-default", { orgId: ORG, default: "500" }, expires);
    const sig = await OWNER.signMessage({ message: msg });
    const ok = await addMemberRoute(req("owner", "POST", { setDefault: 500, signature: sig, message: msg, signerWallet: OWNER.address }), org);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).defaultAllowanceCredits).toBe(500);

    const rogueMsg = memberActionMessage("org-set-default", { orgId: ORG, default: "1" }, expires);
    const rogue = await MEMBER.signMessage({ message: rogueMsg });
    const denied = await addMemberRoute(req("member", "POST", { setDefault: 1, signature: rogue, message: rogueMsg, signerWallet: MEMBER.address }), org);
    expect(denied.status).toBe(403);
  });

  it("invites by wallet alone (did defaults, login matches by wallet)", async () => {
    await foundOwner();
    const expires = Date.now() + 300_000;
    const did = `wallet:${MEMBER.address.toLowerCase()}`;
    const msg = memberActionMessage("member-add", { orgId: ORG, did, wallet: MEMBER.address, role: "member" }, expires);
    const sig = await OWNER.signMessage({ message: msg });
    const r = await addMemberRoute(req("owner", "POST", { member: { walletAddress: MEMBER.address }, signature: sig, message: msg, signerWallet: OWNER.address }), org);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).member.did).toBe(did);
  });

  it("enforces prescoped manager powers (invite+lower allowance+deny, nothing else)", async () => {
    await foundOwner();
    // Owner invites a manager.
    const mgr = await signedAdd("did:mgr", MANAGER.address, "manager");
    const mgrRes = await addMemberRoute(req("owner", "POST", mgr), org);
    expect(mgrRes.status).toBe(200);
    // Owner invites a plain member for the manager to manage.
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    (add.member as any).keyPrefix = "prefixm1abcd";
    await addMemberRoute(req("owner", "POST", add), org);

    const mgrSigned = async (action: string, bind: Record<string, string>) => {
      const message = memberActionMessage(action, bind, Date.now() + 300_000);
      return { message, signature: await MANAGER.signMessage({ message }), signerWallet: MANAGER.address };
    };
    const member = { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) };
    // Manager raises an allowance -> 403 (a spending increase is owner-only).
    const raiseMsg = await mgrSigned("member-set", { orgId: ORG, did: "did:m1" });
    expect((await patchMember(req("manager", "PATCH", { allowanceCredits: 250, ...raiseMsg }), member)).status).toBe(403);
    expect((await patchMember(req("manager", "PATCH", { allowanceCredits: null, ...raiseMsg }), member)).status).toBe(403);
    // Manager lowers an allowance -> 200.
    const setMsg = await mgrSigned("member-set", { orgId: ORG, did: "did:m1" });
    const patched = await patchMember(req("manager", "PATCH", { allowanceCredits: 50, ...setMsg }), member);
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).member.allowanceCredits).toBe(50);
    expect(spendCapCalls.at(-1)).toMatchObject({ address: MEMBER.address, capCredits: 50 });
    // Manager invites a member -> 200.
    const invMsg = memberActionMessage("member-add", { orgId: ORG, did: "did:m2", wallet: MEMBER.address, role: "member" }, Date.now() + 300_000);
    const invited = await addMemberRoute(
      req("manager", "POST", { member: { did: "did:m2", walletAddress: MEMBER.address, role: "member" }, signature: await MANAGER.signMessage({ message: invMsg }), message: invMsg, signerWallet: MANAGER.address }),
      org,
    );
    expect(invited.status).toBe(200);
    // Manager mints an owner -> 403.
    const escMsg = memberActionMessage("member-add", { orgId: ORG, did: "did:evil", wallet: MEMBER.address, role: "owner" }, Date.now() + 300_000);
    const esc = await addMemberRoute(
      req("manager", "POST", { member: { did: "did:evil", walletAddress: MEMBER.address, role: "owner" }, signature: await MANAGER.signMessage({ message: escMsg }), message: escMsg, signerWallet: MANAGER.address }),
      org,
    );
    expect(esc.status).toBe(403);
    // Manager removes -> 403.
    const rmMsg = await mgrSigned("member-remove", { orgId: ORG, did: "did:m1" });
    const removed = await removeMemberRoute(req("manager", "DELETE", rmMsg), member);
    expect(removed.status).toBe(403);
    // Plain member sets allowance -> 403.
    const memMsg = memberActionMessage("member-set", { orgId: ORG, did: "did:m1" }, Date.now() + 300_000);
    const memSig = await MEMBER.signMessage({ message: memMsg });
    const memSet = await patchMember(req("member", "PATCH", { allowanceCredits: 5, signature: memSig, message: memMsg, signerWallet: MEMBER.address }), member);
    expect(memSet.status).toBe(403);
    // Manager changes a role -> 403 (owner-only).
    const roleMsg = await mgrSigned("member-set", { orgId: ORG, did: "did:m1" });
    const roleCh = await patchMember(req("manager", "PATCH", { role: "manager", ...roleMsg }), member);
    expect(roleCh.status).toBe(403);
    // Manager approves an increase request -> 403; only an owner grants it.
    const reqMsg = memberActionMessage("increase-request", { orgId: ORG, memberDid: "did:m1", amountCredits: "300" }, Date.now() + 300_000);
    const reqSig = await MEMBER.signMessage({ message: reqMsg });
    const created = await createRequestRoute(
      req("member", "POST", { memberDid: "did:m1", amountCredits: 300, signature: reqSig, message: reqMsg, signerWallet: MEMBER.address }),
      org,
    );
    expect(created.status).toBe(200);
    const request = ((await created.json()) as any).request;
    const decMsg = approvalMessage(request, "approve", Date.now() + 300_000);
    const decSig = await MANAGER.signMessage({ message: decMsg });
    const decided = await decideRoute(
      req("manager", "POST", { decision: "approve", signerWallet: MANAGER.address, signature: decSig, message: decMsg }),
      { params: Promise.resolve({ orgId: ORG, id: request.id }) },
    );
    expect(decided.status).toBe(403);
    const denyMsg = approvalMessage(request, "deny", Date.now() + 300_000);
    const denied = await decideRoute(
      req("manager", "POST", { decision: "deny", signerWallet: MANAGER.address, signature: await MANAGER.signMessage({ message: denyMsg }), message: denyMsg }),
      { params: Promise.resolve({ orgId: ORG, id: request.id }) },
    );
    expect(denied.status).toBe(200);
    expect(((await denied.json()) as any).request.status).toBe("denied");
  });

  it("binds a key prefix only to the member whose login issued that key", async () => {
    await foundOwner();
    const before = spendCapCalls.length;
    for (const prefix of ["tor_sk_VICTM", "tor_sk_UNKWN"]) {
      const add = await signedAdd("did:m1", MEMBER.address, "member", 0);
      (add.member as any).keyPrefix = prefix;
      expect((await addMemberRoute(req("owner", "POST", add), org)).status).toBe(403);
    }
    expect(spendCapCalls.length).toBe(before);
  });

  it("edits allowance (sync-first) and removes members", async () => {
    await foundOwner();
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    (add.member as any).keyPrefix = "prefixm1abcd";
    await addMemberRoute(req("owner", "POST", add), org);
    const member = { params: Promise.resolve({ orgId: ORG, did: "did:m1" }) };

    const expires = Date.now() + 300_000;
    const setMsg = memberActionMessage("member-set", { orgId: ORG, did: "did:m1" }, expires);
    const setSig = await OWNER.signMessage({ message: setMsg });
    const patched = await patchMember(req("owner", "PATCH", { allowanceCredits: 250, signature: setSig, message: setMsg, signerWallet: OWNER.address }), member);
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as any).member.allowanceCredits).toBe(250);

    const rmMsg = memberActionMessage("member-remove", { orgId: ORG, did: "did:m1" }, expires);
    const rmSig = await OWNER.signMessage({ message: rmMsg });
    const removed = await removeMemberRoute(req("owner", "DELETE", { signature: rmSig, message: rmMsg, signerWallet: OWNER.address }), member);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as any).member.status).toBe("removed");
    // onchain mirror: ex-member denied (cap 0) before removal
    expect(spendCapCalls.at(-1)).toMatchObject({ address: MEMBER.address, prefix: "prefixm1abcd", capCredits: 0 });
  });
});

describe("requests routes", () => {
  it("member requests, owner approves with wallet signature, cap applies", async () => {
    await foundOwner();
    const add = await signedAdd("did:m1", MEMBER.address, "member", 100);
    (add.member as any).keyPrefix = "prefixm1abcd";
    await addMemberRoute(req("owner", "POST", add), org);

    // member-signed increase request
    const expires = Date.now() + 300_000;
    const reqMsg = memberActionMessage("increase-request", { orgId: ORG, memberDid: "did:m1", amountCredits: "400" }, expires);
    const reqSig = await MEMBER.signMessage({ message: reqMsg });
    const created = await createRequestRoute(
      req("member", "POST", { memberDid: "did:m1", amountCredits: 400, signature: reqSig, message: reqMsg, signerWallet: MEMBER.address }),
      org,
    );
    expect(created.status).toBe(200);
    const reqId = ((await created.json()) as any).request.id;

    const inbox = await listRequests(req("owner", "GET", undefined, "http://x/api?status=pending"), org);
    expect(((await inbox.json()) as any).data).toHaveLength(1);

    // owner approves with wallet signature over the canonical decision message
    const decExpires = Date.now() + 300_000;
    const decMsg = approvalMessage({ id: reqId, orgId: ORG, memberDid: "did:m1", amountCredits: 400 }, "approve", decExpires);
    const decSig = await OWNER.signMessage({ message: decMsg });
    const decided = await decideRoute(
      req("owner", "POST", { decision: "approve", signature: decSig, message: decMsg, signerWallet: OWNER.address }),
      { params: Promise.resolve({ orgId: ORG, id: reqId }) },
    );
    expect(decided.status).toBe(200);
    const body: any = await decided.json();
    expect(body.request.status).toBe("approved");
    expect(body.request.decisionSigner).toBe(OWNER.address);
    expect(body.gatewaySynced).toBe(true);
  });
});
