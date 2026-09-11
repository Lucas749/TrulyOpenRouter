import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// The web server never creates Privy wallets itself; it only lists them.
vi.mock("../../../../lib/privy-server", () => ({
  privyApi: vi.fn(async (method: string, path: string) => {
    if (method === "GET" && path === "/organizations") return { data: [{ id: "org-test" }, { id: "org-stranger" }] };
    if (method === "GET" && path === "/wallets") {
      return { data: [{ id: "w-test", address: "0xabc", entity: { id: "org-test" }, policy_ids: ["pol-test"] }, { id: "w-other", address: "0xdef", entity: { id: "org-stranger" } }] };
    }
    throw new Error(`unexpected Privy call ${method} ${path}`);
  }),
}));

import { GET as listOrgs, POST as createOrg } from "./route";
import { getMember } from "../../../../lib/members";

const CREATOR = "0x1111111111111111111111111111111111111111";
const post = (body: unknown, token: string | null = "creator") =>
  new Request("http://x", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

const gatewayCalls: Array<{ url: string; body: any; auth: string }> = [];
let provisionFails = false;

describe("team creation", () => {
  beforeEach(async () => {
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = "app";
    process.env.PRIVY_APP_SECRET = "secret";
    process.env.GATEWAY_ADMIN_TOKEN = "orgs-test-token";
    process.env.GATEWAY_URL = "http://gateway";
    sessions.clear();
    sessions.set("creator", { userId: "did:privy:creator", wallets: [CREATOR] });
    sessions.set("stranger", { userId: "did:privy:stranger", wallets: ["0x2222222222222222222222222222222222222222"] });
    sessions.set("walletless", { userId: "did:privy:walletless", wallets: [] });
    gatewayCalls.length = 0;
    provisionFails = false;
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      const u = String(url);
      gatewayCalls.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")), auth: String(init?.headers?.Authorization ?? "") });
      if (u === "http://gateway/api/admin/teams") {
        if (provisionFails) return Response.json({ error: { message: "The team wallet is not safe to activate: the quorum threshold is not 2." } }, { status: 502 });
        const body = JSON.parse(String(init.body));
        return Response.json({ team: { orgId: "org-test", name: body.name, walletId: "w-test", walletAddress: "0xabc", quorumId: "quorum-test", policyId: "pol-test", approverUserId: body.approverUserId, payoutRecipients: body.recipients, state: "active" } });
      }
      if (u === "http://gateway/api/admin/teams/org-test/snapshot") return Response.json({ revision: 1, changed: true, removed: [] });
      throw new Error(`unexpected fetch ${u}`);
    }));
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-orgs-"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects team creation without a verified login or linked wallet", async () => {
    expect((await createOrg(post({ name: "Acme" }, null))).status).toBe(401);
    expect((await createOrg(post({ name: "Acme" }, "forged"))).status).toBe(401);
    expect((await createOrg(post({ name: "Acme" }, "walletless"))).status).toBe(400);
    expect((await createOrg(post({ name: "" }))).status).toBe(400);
    expect(gatewayCalls).toHaveLength(0);
  });

  it("provisions through the gateway with the verified login as approver, owner, and payout recipient", async () => {
    const r = await createOrg(post({ name: "Acme", creatorWallet: "0x3333333333333333333333333333333333333333", approverUserId: "did:privy:forged" }));
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(gatewayCalls[0]).toEqual({ url: "http://gateway/api/admin/teams", auth: "Bearer orgs-test-token", body: { name: "Acme", approverUserId: "did:privy:creator", recipients: [CREATOR] } });
    expect(d).toMatchObject({ org: { id: "org-test", display_name: "Acme" }, wallet: { id: "w-test", address: "0xabc" }, teamSynced: true });
    expect((await getMember("org-test", "did:privy:creator"))?.role).toBe("owner");
    expect(gatewayCalls[1].body.members).toEqual([{ did: "did:privy:creator", wallet: CREATOR, email: null, role: "owner", status: "active", allowanceCredits: null }]);
  });

  it("records no membership when the gateway refuses to activate the wallet", async () => {
    provisionFails = true;
    const r = await createOrg(post({ name: "Acme" }));
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error).toContain("not safe to activate");
    expect(await getMember("org-test", "did:privy:creator")).toBeNull();
    expect(gatewayCalls).toHaveLength(1);
  });

  it("lists only teams visible to the verified login", async () => {
    await createOrg(post({ name: "Mine" }));
    const mine: any = await (await listOrgs(new Request("http://x", { headers: { authorization: "Bearer creator" } }))).json();
    expect(mine.data.map((o: any) => o.id)).toEqual(["org-test"]);
    expect(mine.data[0].wallets).toEqual([{ id: "w-test", address: "0xabc", policy_ids: ["pol-test"] }]);
    const theirs: any = await (await listOrgs(new Request("http://x", { headers: { authorization: "Bearer stranger" } }))).json();
    expect(theirs.data).toEqual([]);
    expect((await listOrgs(new Request("http://x?wallet=" + CREATOR))).status).toBe(401);
  });
});
