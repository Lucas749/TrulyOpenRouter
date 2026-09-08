import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/privy-server", () => ({
  newAuthKeypair: () => ({ publicKey: "pub", privateKey: "priv" }),
  privyApi: vi.fn(async (method: string, path: string, body?: any) => {
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

import { POST as createOrg } from "./route";
import { privyApi } from "../../../../lib/privy-server";

describe("team org creation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("converts USD caps to HBAR-wei policies", async () => {
    const r = await createOrg(
      new Request("http://x", { method: "POST", body: JSON.stringify({ name: "Acme", capUsd: 25 }) }),
    );
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.wallet.policy_ids).toEqual(["pol-test"]);
    const policyCall: any = (privyApi as any).mock.calls.find((c: any[]) => c[1] === "/policies");
    const rule = policyCall[2].rules[0];
    expect(rule.conditions[0].value).toBe(String(BigInt(312.5e18))); // $25 @ $0.08 = 312.5 HBAR
    expect(d.policy.rules).toEqual(policyCall[2].rules);
  });

  it("rejects bad caps, creates capless teams", async () => {
    const bad = await createOrg(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "Acme", capUsd: -5 }) }));
    expect(bad.status).toBe(400);
    const plain = await createOrg(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "Acme" }) }));
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as any).wallet.policy_ids).toEqual([]);
  });
});
