import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ verifyAuthToken: vi.fn(), getUser: vi.fn() }));
vi.mock("@privy-io/server-auth", () => ({ PrivyClient: class { verifyAuthToken = sdk.verifyAuthToken; getUser = sdk.getUser; } }));

import { isSessionMember, sessionUser } from "./session";

const request = (auth?: string) => new Request("https://example.test/api/team/orgs", { headers: auth ? { authorization: auth } : {} });

describe("team session verification", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "app");
    vi.stubEnv("PRIVY_APP_SECRET", "secret");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

  it("derives identity and wallets from the verified token only", async () => {
    sdk.verifyAuthToken.mockResolvedValue({ userId: "did:privy:owner" });
    sdk.getUser.mockResolvedValue({ linkedAccounts: [
      { type: "wallet", chainType: "ethereum", address: `0x${"AB".repeat(20)}` },
      { type: "wallet", chainType: "solana", address: "not-evm" },
      { type: "email", address: "owner@example.com" },
    ] });
    expect(await sessionUser(request("Bearer token-1"))).toEqual({ userId: "did:privy:owner", wallets: [`0x${"ab".repeat(20)}`], token: "token-1" });
  });

  it("returns null without a token or with an invalid one", async () => {
    expect(await sessionUser(request())).toBeNull();
    sdk.verifyAuthToken.mockRejectedValue(new Error("expired"));
    expect(await sessionUser(request("Bearer stale"))).toBeNull();
    expect(sdk.getUser).not.toHaveBeenCalled();
  });

  it("matches members by subject or linked wallet, never by an unlinked address", () => {
    const s = { userId: "did:privy:owner", wallets: [`0x${"ab".repeat(20)}`], token: "t" };
    expect(isSessionMember({ did: "did:privy:owner", walletAddress: "" }, s)).toBe(true);
    expect(isSessionMember({ did: "wallet:x", walletAddress: `0x${"AB".repeat(20)}` }, s)).toBe(true);
    expect(isSessionMember({ did: "did:privy:other", walletAddress: `0x${"cd".repeat(20)}` }, s)).toBe(false);
  });
});
