import { PrivyClient } from "@privy-io/server-auth";

let client: PrivyClient | undefined;
export async function faucetUser(req: Request): Promise<string | null> {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return null;
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new Error("Login verification is unavailable.");
  client ??= new PrivyClient(appId, secret);
  try { return (await client.verifyAuthToken(token)).userId; }
  catch { return null; }
}
