import { NextResponse } from "next/server";
import { createIncreaseRequest, getMember, listRequests, verifyActionMessage } from "../../../../../../lib/members";
import { requireSession, requireTeamViewer, sessionOwnsWallet, walletNotLinked } from "../../../../../../lib/session";

// GET: pending (default) or all requests for the owner inbox.
export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const { orgId } = await params;
    const session = await requireTeamViewer(req, orgId);
    if (session instanceof Response) return session;
    const status = new URL(req.url).searchParams.get("status") as "pending" | "approved" | "denied" | null;
    return NextResponse.json({ data: await listRequests(orgId, status ?? undefined) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

// POST: a member requests a raise. Signed by the MEMBER's own wallet, linked to
// their login — proves who asked. Body: { memberDid, amountCredits, signature, message, signerWallet }.
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  try {
    const { orgId } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      memberDid?: string;
      amountCredits?: number;
      signature?: string;
      message?: string;
      signerWallet?: string;
    };
    if (!body.memberDid || body.amountCredits === undefined || !body.signature || !body.message || !body.signerWallet) {
      return NextResponse.json({ error: "memberDid + amountCredits + signature + message + signerWallet required" }, { status: 400 });
    }
    if (!Number.isFinite(body.amountCredits) || body.amountCredits <= 0) {
      return NextResponse.json({ error: "amountCredits must be positive" }, { status: 400 });
    }
    const member = await getMember(orgId, body.memberDid);
    if (!member) return NextResponse.json({ error: "member not found" }, { status: 404 });
    let signer: string;
    try {
      signer = await verifyActionMessage(body.message, body.signature, "increase-request", {
        orgId,
        memberDid: body.memberDid,
        amountCredits: String(body.amountCredits),
      });
    } catch (e: any) {
      return NextResponse.json({ error: `bad signature: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 401 });
    }
    if (!sessionOwnsWallet(session, signer)) return walletNotLinked();
    if (signer.toLowerCase() !== member.walletAddress.toLowerCase()) {
      return NextResponse.json({ error: "signer must be the requesting member's wallet" }, { status: 403 });
    }
    return NextResponse.json({ request: await createIncreaseRequest(orgId, body.memberDid, body.amountCredits) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
