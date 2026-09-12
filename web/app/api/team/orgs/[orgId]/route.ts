import { NextResponse } from "next/server";
import { getMember, roleRank, setOrgName } from "../../../../../lib/members";
import { requireSession } from "../../../../../lib/session";
import { syncTeamToGateway } from "../../../../../lib/team-sync";

/// @notice PATCH { name }: rename a team. Owners only, authorized by the verified
/// login alone — a display name moves no funds and grants no authority, so unlike
/// allowances, rules, and removals it carries no wallet signature. The new name is
/// stored here and mirrored to the gateway, which shows it on receipts and approvals.
export async function PATCH(req: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  try {
    const { orgId } = await params;
    const { name } = (await req.json().catch(() => ({}))) as { name?: string };
    if (!name || typeof name !== "string" || !name.trim() || name.trim().length > 64) {
      return NextResponse.json({ error: "name required (<=64 chars)" }, { status: 400 });
    }
    const me = await getMember(orgId, session.userId);
    if (!me || me.status !== "active" || roleRank(me.role) < 2) {
      return NextResponse.json({ error: "only a team owner can rename the team" }, { status: 403 });
    }
    const meta = await setOrgName(orgId, name);
    const synced = await syncTeamToGateway(orgId);
    return NextResponse.json({ org: { id: orgId, display_name: meta.displayName }, gatewaySynced: synced.synced, gatewayError: synced.error });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: /name required/.test(msg) ? 400 : 502 });
  }
}
