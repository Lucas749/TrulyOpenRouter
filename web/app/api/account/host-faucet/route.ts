import { NextResponse } from "next/server";
import { faucetUser } from "../../../../lib/faucet-auth";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const userId = await faucetUser(req);
    if (!userId) return NextResponse.json({ error: { message: "Sign in again to get test HBAR." } }, { status: 401 });
    const body = await req.json().catch(() => null);
    if (typeof body?.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      return NextResponse.json({ error: { message: "Enter a valid host address." } }, { status: 400 });
    }
    const token = process.env.GATEWAY_ADMIN_TOKEN;
    if (!token) throw new Error("Funding is unavailable.");
    const base = (process.env.GATEWAY_URL ?? "http://127.0.0.1:4121").replace(/\/+$/, "");
    const upstream = await fetch(`${base}/api/admin/host-faucet`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // The identity comes from the verified access token, never from the body.
      body: JSON.stringify({ address: body.address, userId }),
      signal: AbortSignal.timeout(45000),
      cache: "no-store",
    });
    return NextResponse.json(await upstream.json(), { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: { message: "We couldn't confirm funding yet. Retry to check the same transfer, or use the Hedera faucet." } }, { status: 503 });
  }
}
