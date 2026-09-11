import { PrivyClient } from "@privy-io/server-auth";
import type { Address } from "viem";

export class SubscriberError extends Error {
  constructor(public status: number, public type: string, message: string) { super(message); }
}

export type VerifySubscriber = (token: string) => Promise<Address[]>;

/// @notice A verified login: the Privy subject plus its server-side linked wallets.
export interface VerifiedSession { userId: string; wallets: Address[] }
export type VerifySession = (token: string) => Promise<VerifiedSession>;

export function privySession(appId?: string, secret?: string): VerifySession {
  const client = appId && secret ? new PrivyClient(appId, secret) : null;
  return async token => {
    if (!client) throw new SubscriberError(503, "auth_unavailable", "Login verification is unavailable. Try again later.");
    let userId: string;
    try { userId = (await client.verifyAuthToken(token)).userId; }
    catch { throw new SubscriberError(401, "authentication_required", "Sign in again to continue."); }
    try {
      const user = await client.getUser(userId);
      return { userId, wallets: user.linkedAccounts.flatMap(account =>
        account.type === "wallet" && account.chainType === "ethereum" && /^0x[\da-f]{40}$/i.test(account.address)
          ? [account.address.toLowerCase() as Address] : []) };
    } catch { throw new SubscriberError(503, "auth_unavailable", "Wallet ownership could not be verified. Try again later."); }
  };
}

export function privySubscriber(appId?: string, secret?: string): VerifySubscriber {
  const session = privySession(appId, secret);
  return async token => (await session(token)).wallets;
}

export async function subscriberWallet(token: string | undefined, claimed: unknown, verify?: VerifySubscriber): Promise<Address> {
  if (!token) throw new SubscriberError(401, "authentication_required", "Sign in or provide a funded API key to continue.");
  if (!verify) throw new SubscriberError(503, "auth_unavailable", "Login verification is unavailable. Try again later.");
  const wallets = await verify(token);
  const address = typeof claimed === "string" ? claimed.toLowerCase() : wallets[0]?.toLowerCase();
  if (!address || !wallets.some(wallet => wallet.toLowerCase() === address)) {
    throw new SubscriberError(403, "wallet_not_owned", "Choose a wallet linked to your signed-in account.");
  }
  return address as Address;
}
