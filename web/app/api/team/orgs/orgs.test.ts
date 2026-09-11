import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../../../lib/privy-server", () => ({
  newAuthKeypair: () => ({ publicKey: "pub", privateKey: "priv" }),
  privyApi: vi.fn(async (method: string, path: string, body?: any) => {
    if (method === "GET" && path === "/organizations") return { data: [{ id: "org-test" }, { id: "org-stranger" }] };
    if (method === "GET" && path === "/wallets") {
      return { data: [{ id: "w-test", address: "0xabc", entity: { id: "org-test" } }, { id: "w-other", address: "0xdef", entity: { id: "org-stranger" } }] };
    }
    if (path === "/key_quorums") return { id: "quorum-test" };
    if (path === "/organizations") return { id: "org-test" };
    if (path === "/policies") return { id: "pol-test", rules: body.rules };
    if (path === "/wallets") return { id: "w-test", address: "0xabc", policy_ids: body.policy_ids ?? [] };
    throw new Error(`unexpected ${path}`);
  }),
}));

vi.mock("../../../../lib/quorum-keys", () => ({
  saveQuorumKey: vi.fn(),
}));

import { GET as listOrgs, POST as createOrg } from "./route";
import { privyApi } from "../../../../lib/privy-server";

const CREATOR = "0x1111111111111111111111111111111111111111";
const post = (body: unknown, token: string | null = "creator") =>
  new Request("http://x", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

describe("team org creation", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = "app";
    process.env.PRIVY_APP_SECRET = "secret";
    sessions.clear();
    sessions.set("creator", { userId: "did:privy:creator", wallets: [CREATOR] });
    sessions.set("stranger", { userId: "did:privy:stranger", wallets: ["0x2222222222222222222222222222222222222222"] });
    sessions.set("walletless", { userId: "did:privy:walletless", wallets: [] });
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-orgs-"));
  });

  it("rejects team creation without a verified login or linked wallet", async () => {
    expect((await createOrg(post({ name: "Acme" }, null))).status).toBe(401);
    expect((await createOrg(post({ name: "Acme" }, "forged"))).status).toBe(401);
    expect((await createOrg(post({ name: "Acme" }, "walletless"))).status).toBe(400);
    expect((privyApi as any).mock.calls).toHaveLength(0);
  });

  it("converts USD caps to HBAR-wei policies", async () => {
    const r = await createOrg(post({ name: "Acme", capUsd: 25 }));
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.wallet.policy_ids).toEqual(["pol-test"]);
    const policyCall: any = (privyApi as any).mock.calls.find((c: any[]) => c[1] === "/policies");
    const rule = policyCall[2].rules[0];
    expect(rule.conditions[0].value).toBe(String(BigInt(312.5e18))); // $25 @ $0.08 = 312.5 HBAR
    expect(d.policy.rules).toEqual(policyCall[2].rules);
  });

  it("rejects bad caps, creates capless teams", async () => {
    const bad = await createOrg(post({ name: "Acme", capUsd: -5 }));
    expect(bad.status).toBe(400);
    const plain = await createOrg(post({ name: "Acme" }));
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as any).wallet.policy_ids).toEqual([]);
  });

  it("makes the verified login the founding owner and ignores a claimed creator", async () => {
    const claimed = "0x3333333333333333333333333333333333333333";
    const r = await createOrg(post({ name: "Mine", creatorWallet: claimed }));
    expect(r.status).toBe(200);
    const { getMember, visibleOrgIds } = await import("../../../../lib/members");
    const me = await getMember("org-test", "did:privy:creator");
    expect(me?.role).toBe("owner");
    expect(me?.walletAddress).toBe(CREATOR);
    expect(await visibleOrgIds({ userId: "did:privy:creator", wallets: [CREATOR] })).toContain("org-test");
    expect(await visibleOrgIds({ userId: "did:privy:someone", wallets: [claimed] })).not.toContain("org-test");
  });

  it("lists only teams visible to the verified login", async () => {
    await createOrg(post({ name: "Mine" }));
    const mine: any = await (await listOrgs(new Request("http://x", { headers: { authorization: "Bearer creator" } }))).json();
    expect(mine.data.map((o: any) => o.id)).toEqual(["org-test"]);
    expect(mine.data[0].wallets).toEqual([{ id: "w-test", address: "0xabc", policy_ids: [] }]);
    const theirs: any = await (await listOrgs(new Request("http://x", { headers: { authorization: "Bearer stranger" } }))).json();
    expect(theirs.data).toEqual([]);
    expect((await listOrgs(new Request("http://x?wallet=" + CREATOR))).status).toBe(401);
  });
});
