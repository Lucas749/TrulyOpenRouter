import { NextResponse } from "next/server";
import { getOrgMeta, getRules, listRuleChanges, memberByWallet, proposeRuleChange, roleRank, verifyActionMessage } from "../../../../../../lib/members";
import { requireSession, requireTeamViewer, sessionOwnsWallet, walletNotLinked } from "../../../../../../lib/session";

// GET: current rules + change history for the org.
// POST: propose a change (owner/manager-signed). Body:
//   { kind: daily_cap|models|per_tx_cap, payload, memberDid, signature, message, signerWallet }
// The signed message binds action "rule-propose" + {orgId, kind, payload: stableJson}.
export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
  try {
    const { orgId } = await params;
    const session = await requireTeamViewer(req, orgId);
    if (session instanceof Response) return session;
    const status = new URL(req.url).searchParams.get("status") as "pending" | "approved" | "denied" | null;
    return NextResponse.json({ rules: await getRules(orgId), changes: await listRuleChanges(orgId, status ?? undefined) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  try {
    const { orgId } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      kind?: string;
      payload?: Record<string, unknown>;
      memberDid?: string;
      signature?: string;
      message?: string;
      signerWallet?: string;
    };
    if (!body.kind || !body.payload || typeof body.payload !== "object" || !body.memberDid || !body.signature || !body.message || !body.signerWallet) {
      return NextResponse.json({ error: "kind + payload + memberDid + signature + message + signerWallet required" }, { status: 400 });
    }
    if (!sessionOwnsWallet(session, body.signerWallet)) return walletNotLinked();
    const proposer = await memberByWallet(orgId, body.signerWallet);
    if (!proposer || roleRank(proposer.role) < 1) {
      return NextResponse.json({ error: "signer is not an owner or manager" }, { status: 403 });
    }
    let signer: string;
    try {
      const { stableJson: sj } = await import("../../../../../../lib/member-messages");
      signer = await verifyActionMessage(body.message, body.signature, "rule-propose", {
        orgId,
        kind: body.kind,
        payload: sj(body.payload),
      });
    } catch (e: any) {
      return NextResponse.json({ error: `bad signature: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 401 });
    }
    if (signer.toLowerCase() !== proposer.walletAddress.toLowerCase()) {
      return NextResponse.json({ error: "signer must be the proposing member's wallet" }, { status: 403 });
    }
    const meta = await getOrgMeta(orgId);
    const member = meta?.members.find((m) => m.did === body.memberDid && m.status === "active");
    if (!member || member.walletAddress.toLowerCase() !== signer.toLowerCase()) {
      return NextResponse.json({ error: "memberDid must be the signer" }, { status: 403 });
    }
    try {
      return NextResponse.json({ change: await proposeRuleChange(orgId, body.kind, body.payload, body.memberDid) });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const bad = /unknown rule kind|must be|required/.test(msg);
      return NextResponse.json({ error: msg.slice(0, 200) }, { status: bad ? 400 : 502 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
