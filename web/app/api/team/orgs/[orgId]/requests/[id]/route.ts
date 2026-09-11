import { NextResponse } from "next/server";
import { approvalMessage, decideRequest, getMember, getOrgMeta, getRequest, memberByWallet, roleRank, spendCapFor } from "../../../../../../../lib/members";
import { syncCap, syncSpendCap } from "../../../../../../../lib/gateway-admin";
import { requireSession, sessionOwnsWallet, walletNotLinked } from "../../../../../../../lib/session";

// POST: owner/manager decides. Signed by the decider's wallet (linked to their
// login) over the canonical decision message (useSignMessage); the signature +
// recovered signer are stored on the request as the audit trail.
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string; id: string }> }) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
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
    if (!sessionOwnsWallet(session, body.signerWallet)) return walletNotLinked();
    const r = await getRequest(id);
    if (!r || r.orgId !== orgId) return NextResponse.json({ error: "request not found" }, { status: 404 });
    const decider = await memberByWallet(orgId, String(body.signerWallet));
    if (!decider || roleRank(decider.role) < 1) {
      return NextResponse.json({ error: "signer is not an owner or manager" }, { status: 403 });
    }
    const owner = decider;
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
      const member = await getMember(orgId, decided.memberDid);
      if (member?.keyPrefix) {
        try {
          await syncCap(member.keyPrefix, decided.amountCredits);
        } catch (e: any) {
          // Decision stands (signed + recorded); enforcement sync is retried from the UI.
          return NextResponse.json({ request: decided, gatewaySynced: false, gatewayError: String(e?.message ?? e).slice(0, 120) }, { status: 207 });
        }
      }
      // Onchain mirror of the newly approved cap. Best-effort, reported next
      // to the gateway flag — same "decision stands" rationale as above.
      const metaAfter = await getOrgMeta(orgId);
      const { capCredits, periodDays } = spendCapFor(metaAfter!, decided.memberDid);
      const chainSync = member
        ? await syncSpendCap({ address: member.walletAddress || undefined, prefix: member.keyPrefix ?? undefined, capCredits, periodDays })
        : "skipped";
      return NextResponse.json({ request: decided, gatewaySynced: true, chainSynced: chainSync });
    }
    return NextResponse.json({ request: decided, gatewaySynced: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
