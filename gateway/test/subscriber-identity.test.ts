import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ verifyAuthToken: vi.fn(), getUser: vi.fn() }));
vi.mock("@privy-io/server-auth", () => ({ PrivyClient: class { verifyAuthToken = sdk.verifyAuthToken; getUser = sdk.getUser; } }));
import { privySession, privySubscriber } from "../src/subscriber.js";

beforeEach(() => { vi.resetAllMocks(); });
it("derives wallet ownership from the verified subject and server-side linked accounts", async () => {
  sdk.verifyAuthToken.mockResolvedValue({ userId: "did:privy:verified" });
  sdk.getUser.mockResolvedValue({ linkedAccounts: [
    { type: "wallet", chainType: "ethereum", address: `0x${"AB".repeat(20)}` },
    { type: "wallet", chainType: "solana", address: "unrelated" },
    { type: "email", address: "person@example.com" },
  ] });
  expect(await privySubscriber("app", "secret")("signed-token")).toEqual([`0x${"ab".repeat(20)}`]);
  expect(sdk.verifyAuthToken.mock.calls).toEqual([["signed-token"]]);
  expect(sdk.getUser.mock.calls).toEqual([["did:privy:verified"]]);
});
it("returns the verified subject together with its linked wallets", async () => {
  sdk.verifyAuthToken.mockResolvedValue({ userId: "did:privy:owner" });
  sdk.getUser.mockResolvedValue({ linkedAccounts: [{ type: "wallet", chainType: "ethereum", address: `0x${"CD".repeat(20)}` }] });
  expect(await privySession("app", "secret")("signed-token")).toEqual({ userId: "did:privy:owner", wallets: [`0x${"cd".repeat(20)}`] });
});
it("rejects invalid tokens before fetching wallet ownership", async () => {
  sdk.verifyAuthToken.mockRejectedValue(new Error("expired signature"));
  await expect(privySubscriber("app", "secret")("expired")).rejects.toMatchObject({ status: 401 });
  expect(sdk.getUser.mock.calls).toHaveLength(0);
});
it("fails closed on missing configuration and ownership lookup outages", async () => {
  await expect(privySubscriber()("token")).rejects.toMatchObject({ status: 503 });
  sdk.verifyAuthToken.mockResolvedValue({ userId: "did:privy:verified" });
  sdk.getUser.mockRejectedValue(new Error("offline"));
  await expect(privySubscriber("app", "secret")("token")).rejects.toMatchObject({ status: 503 });
});
