import { NextResponse } from "next/server";
import { claimInvite, getOrgMeta, spendCapFor } from "../../../../../../../lib/members";
import { syncSpendCap } from "../../../../../../../lib/gateway-admin";
import { requireSession, sessionOwnsWallet, walletNotLinked } from "../../../../../../../lib/session";

// POST: invitee claims an email invite. The verified login supplies the did and
// email; the wallet signature over the canonical "invite-claim" message proves
// the linked wallet (it binds orgId + email + did + wallet).
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
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
    if (body.did !== session.userId) return NextResponse.json({ error: "claims bind your own login" }, { status: 403 });
    if (!sessionOwnsWallet(session, body.walletAddress)) return walletNotLinked();
    if (!session.emails.includes(body.email.trim().toLowerCase())) {
      return NextResponse.json({ error: "accept invites sent to your login email" }, { status: 403 });
    }
    try {
      const m = await claimInvite(orgId, body.email, body.did, body.walletAddress, body.signature, body.message);
      // Newly active: mirror the (possibly pre-set) allowance onchain now.
      const metaAfter = await getOrgMeta(orgId);
      const { capCredits, periodDays } = spendCapFor(metaAfter!, m.did);
      const chainSync = await syncSpendCap({
        address: m.walletAddress || undefined,
        prefix: m.keyPrefix ?? undefined,
        capCredits,
        periodDays,
      });
      return NextResponse.json({ member: m, chainSynced: chainSync });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = /expired|sign again/.test(msg) ? 401 : /no pending invite/.test(msg) ? 404 : /already active|does not match|must own|wrong action/.test(msg) ? 409 : 400;
      return NextResponse.json({ error: msg.slice(0, 160) }, { status });
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
