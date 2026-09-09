import { NextResponse } from "next/server";
import { decideRuleChange, getOrgMeta, listRuleChanges, memberByWallet, roleRank } from "../../../../../../../../lib/members";
import { syncOrgRules } from "../../../../../../../../lib/gateway-admin";

// GET: pending (default) or all rule changes for the inbox.
// POST /:id { decision, signerWallet, signature, message }: owner decides.
// The signed message must equal the server-rebuilt ruleDecisionMessage.
// On approve: rules applied locally AND synced to gateway enforcement.
export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
  try {
    const { orgId } = await params;
    const status = new URL(req.url).searchParams.get("status") as "pending" | "approved" | "denied" | null;
    return NextResponse.json({ changes: await listRuleChanges(orgId, status ?? "pending") });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string; id: string }> }): Promise<Response> {
  try {
    const { orgId, id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      decision?: string;
      signerWallet?: string;
      signature?: string;
      message?: string;
    };
    if ((body.decision !== "approve" && body.decision !== "deny") || !body.signerWallet || !body.signature || !body.message) {
      return NextResponse.json({ error: "decision approve|deny + signerWallet + signature + message required" }, { status: 400 });
    }
    const decider = await memberByWallet(orgId, String(body.signerWallet));
    if (!decider || roleRank(decider.role) < 2) {
      return NextResponse.json({ error: "signer is not an active owner" }, { status: 403 });
    }
    let decided;
    try {
      decided = await decideRuleChange(id, body.decision, decider.did, decider.walletAddress, body.signature, body.message);
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 401 });
    }
    let gatewaySynced = false;
    let gatewayError: string | null = null;
    if (decided.status === "approved") {
      // Sync org rules + member handles to gateway pre-flight enforcement.
      const meta = await getOrgMeta(orgId);
      const { getRules } = await import("../../../../../../../../lib/members");
      const rules = await getRules(orgId);
      const handles = (meta?.members ?? [])
        .filter((m) => m.status === "active")
        .flatMap((m) => [`wallet:${m.walletAddress.toLowerCase()}`, ...(m.keyPrefix ? [`key:${m.keyPrefix}`] : [])]);
      try {
        await syncOrgRules(orgId, {
          dailyCapCredits: rules.dailyCapCredits ?? null,
          allowedModels: rules.allowedModels ?? null,
          allowedRegions: rules.allowedRegions ?? null,
          requireVerified: rules.requireVerified ?? false,
          rateLimitPerMin: rules.rateLimitPerMin ?? null,
          pinnedHosts: rules.pinnedHosts ?? null,
          handles,
        });
        gatewaySynced = true;
      } catch (e: any) {
        gatewayError = String(e?.message ?? e).slice(0, 120);
      }
    }
    return NextResponse.json({ change: decided, gatewaySynced, gatewayError });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
