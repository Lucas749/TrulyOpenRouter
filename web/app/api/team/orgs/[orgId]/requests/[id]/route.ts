import { NextResponse } from "next/server";
import { approvalMessage, decideRequest, getMember, getOrgMeta, getRequest } from "../../../../../../../lib/members";
import { syncCap } from "../../../../../../../lib/gateway-admin";

// POST: owner decides. Signed by the OWNER's wallet over the canonical decision
// message (useSignMessage); the signature + recovered signer are stored on the
// request as the audit trail, then the quorum intent path executes.
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string; id: string }> }) {
  try {
    const { orgId, id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      decision?: string;
      signature?: string;
      message?: string;
      signerWallet?: string;
    };
    if ((body.decision !== "approve" && body.decision !== "deny") || !body.signature || !body.message || !body.signerWallet) {
      return NextResponse.json({ error: "decision approve|deny + signature + message + signerWallet required" }, { status: 400 });
    }
    const r = getRequest(id);
    if (!r || r.orgId !== orgId) return NextResponse.json({ error: "request not found" }, { status: 404 });
    const meta = getOrgMeta(orgId);
    const owner = meta?.members.find((m) => m.role === "owner" && m.status === "active" && m.walletAddress.toLowerCase() === String(body.signerWallet).toLowerCase());
    if (!owner) return NextResponse.json({ error: "signer is not an active owner" }, { status: 403 });
    // Rebuild the expected message server-side: the signature must bind THIS decision.
    const expected = approvalMessage(r, body.decision, Number((body.message.match(/^expires: (\d+)$/m) ?? [])[1]));
    if (body.message !== expected) {
      return NextResponse.json({ error: "message does not match this decision (action/org/member/cap/expiry)" }, { status: 400 });
    }
    let decided;
    try {
      decided = await decideRequest(id, body.decision, owner.did, owner.walletAddress, body.signature, body.message);
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 401 });
    }
    if (decided.status === "approved") {
      const member = getMember(orgId, decided.memberDid)!;
      if (member.keyPrefix) {
        try {
          await syncCap(member.keyPrefix, decided.amountCredits);
        } catch (e: any) {
          // Decision stands (signed + recorded); enforcement sync is retried from the UI.
          return NextResponse.json({ request: decided, gatewaySynced: false, gatewayError: String(e?.message ?? e).slice(0, 120) }, { status: 207 });
        }
      }
    }
    return NextResponse.json({ request: decided, gatewaySynced: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
