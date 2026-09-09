import { NextResponse } from "next/server";
import { memberByWallet, roleRank, setRuleDirect } from "../../../../../../../lib/members";
import { syncRulesToGateway } from "../../../../../../../lib/rule-sync";

// POST /set { kind, payload, memberDid, signature, message, signerWallet }:
// owner sets a rule DIRECTLY — one wallet signature, applied + synced immediately.
// (Managers use propose → inbox → owner approves instead.) The message binds
// action "rule-set" + {orgId, kind, payload} + expiry, canonical form.
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
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
    const setter = await memberByWallet(orgId, String(body.signerWallet));
    if (!setter || roleRank(setter.role) < 2) {
      return NextResponse.json({ error: "only owners can set rules directly (managers propose)" }, { status: 403 });
    }
    if (setter.did !== body.memberDid || setter.walletAddress.toLowerCase() !== String(body.signerWallet).toLowerCase()) {
      return NextResponse.json({ error: "memberDid must be the signer" }, { status: 403 });
    }
    let rules;
    try {
      rules = await setRuleDirect(orgId, body.kind, body.payload, body.memberDid, setter.walletAddress, body.signature, body.message);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = /unknown rule kind|must be|does not match|not from the recorded|expired/.test(msg) ? 400 : 502;
      return NextResponse.json({ error: msg.slice(0, 200) }, { status });
    }
    const s = await syncRulesToGateway(orgId);
    return NextResponse.json({ rules, gatewaySynced: s.synced, gatewayError: s.error });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
