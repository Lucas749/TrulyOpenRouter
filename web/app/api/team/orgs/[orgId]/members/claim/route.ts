import { NextResponse } from "next/server";
import { claimInvite } from "../../../../../../../lib/members";

// POST: invitee claims an email invite by proving wallet ownership. No org
// membership needed — the wallet signature over the canonical "invite-claim"
// message IS the auth (it binds orgId + email + did + wallet).
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const { orgId } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      email?: string;
      did?: string;
      walletAddress?: string;
      signature?: string;
      message?: string;
    };
    if (!body.email || !body.did || !body.walletAddress || !body.signature || !body.message) {
      return NextResponse.json({ error: "email + did + walletAddress + signature + message required" }, { status: 400 });
    }
    try {
      const m = await claimInvite(orgId, body.email, body.did, body.walletAddress, body.signature, body.message);
      return NextResponse.json({ member: m });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = /expired|sign again/.test(msg) ? 401 : /no pending invite/.test(msg) ? 404 : /already active|does not match|must own|wrong action/.test(msg) ? 409 : 400;
      return NextResponse.json({ error: msg.slice(0, 160) }, { status });
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
