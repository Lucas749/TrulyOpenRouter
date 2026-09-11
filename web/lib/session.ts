import { PrivyClient } from "@privy-io/server-auth";

// Verified login for team routes: the Privy subject plus wallets linked to it
// server-side. Request bodies never establish identity (faucet-auth.ts only
// needs the subject, so it stays separate).

export interface SessionUser {
  userId: string;
  wallets: string[]; // lowercased EVM addresses linked to the login
  token: string;
}

let client: PrivyClient | undefined;

export async function sessionUser(req: Request): Promise<SessionUser | null> {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return null;
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new Error("Login verification is unavailable.");
  client ??= new PrivyClient(appId, secret);
  let userId: string;
  try {
    userId = (await client.verifyAuthToken(token)).userId;
  } catch {
    return null;
  }
  const user = await client.getUser(userId);
  const wallets = user.linkedAccounts.flatMap((a: any) =>
    a.type === "wallet" && a.chainType === "ethereum" && /^0x[0-9a-fA-F]{40}$/.test(a.address) ? [String(a.address).toLowerCase()] : [],
  );
  return { userId, wallets, token };
}

/// @notice True when a member row belongs to this login (Privy subject or a linked wallet).
export function isSessionMember(m: { did: string; walletAddress: string }, s: SessionUser): boolean {
  return m.did === s.userId || (!!m.walletAddress && s.wallets.includes(m.walletAddress.toLowerCase()));
}
