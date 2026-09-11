import { NextResponse } from "next/server";
import { PrivyClient } from "@privy-io/server-auth";
import { visibleOrgIds } from "./members";

// Verified login for team routes: the Privy subject plus wallets linked to it
// server-side. Request bodies never establish identity (faucet-auth.ts only
// needs the subject, so it stays separate).

export interface SessionUser {
  userId: string;
  wallets: string[]; // lowercased EVM addresses linked to the login
  emails: string[]; // lowercased verified login emails
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
  const accounts = user.linkedAccounts as Array<{ type: string; chainType?: string; address?: string }>;
  const wallets = accounts.flatMap((a) =>
    a.type === "wallet" && a.chainType === "ethereum" && /^0x[0-9a-fA-F]{40}$/.test(a.address ?? "") ? [String(a.address).toLowerCase()] : [],
  );
  const emails = accounts.flatMap((a) => (a.type === "email" && a.address ? [a.address.toLowerCase()] : []));
  return { userId, wallets, emails, token };
}

/// @notice Route guard: the verified session, or the 401/503 response to return.
export async function requireSession(req: Request): Promise<SessionUser | Response> {
  try {
    return (await sessionUser(req)) ?? NextResponse.json({ error: "Sign in again to continue." }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "Login verification is unavailable. Try again later." }, { status: 503 });
  }
}

/// @notice True when a member row belongs to this login (Privy subject or a linked wallet).
export function isSessionMember(m: { did: string; walletAddress: string }, s: SessionUser): boolean {
  return m.did === s.userId || (!!m.walletAddress && s.wallets.includes(m.walletAddress.toLowerCase()));
}

/// @notice A wallet signature only counts for team actions when that wallet is linked to the login.
export function sessionOwnsWallet(s: SessionUser, wallet: string | undefined | null): boolean {
  return !!wallet && s.wallets.includes(wallet.toLowerCase());
}

export function walletNotLinked(): Response {
  return NextResponse.json({ error: "Sign with a wallet linked to your login." }, { status: 403 });
}

/// @notice Route guard for team-scoped reads and writes: a verified session that
/// created, belongs to, or is invited to this team. Others get 404, not a listing.
export async function requireTeamViewer(req: Request, orgId: string): Promise<SessionUser | Response> {
  const s = await requireSession(req);
  if (s instanceof Response) return s;
  return (await visibleOrgIds(s)).has(orgId) ? s : NextResponse.json({ error: "team not found" }, { status: 404 });
}
