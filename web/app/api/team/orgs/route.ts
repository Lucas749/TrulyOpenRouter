import { NextResponse } from "next/server";
import { privyApi } from "../../../../lib/privy-server";
import { addMember, setOrgCreator, visibleOrgIds } from "../../../../lib/members";
import { provisionTeam } from "../../../../lib/gateway-admin";
import { requireSession } from "../../../../lib/session";
import { syncTeamToGateway } from "../../../../lib/team-sync";

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  try {
    const orgs: any = await privyApi("GET", "/organizations");
    const list: any[] = orgs.data ?? orgs ?? [];
    const wallets: any = await privyApi("GET", "/wallets").catch(() => ({ data: [] }));
    const all: any[] = wallets.data ?? [];
    // Only orgs this login created, belongs to, or is invited to. There is no
    // unfiltered listing: identity comes from the verified token.
    const visible = await visibleOrgIds(session);
    return NextResponse.json({
      data: list
        .filter((o: any) => visible.has(o.id))
        .map((o: any) => ({
          ...o,
          wallets: all
            .filter((w: any) => w.entity?.id === o.id)
            .map((w: any) => ({ id: w.id, address: w.address, policy_ids: w.policy_ids ?? [] })),
        })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

/// @notice Create a team: the gateway provisions a Privy organization wallet owned
/// by a 2-of-2 quorum of this verified login (financial approver) and the broker
/// key, with the treasury policy attached. The login becomes the founding owner.
export async function POST(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  try {
    const { name } = (await req.json().catch(() => ({}))) as { name?: string };
    if (!name || typeof name !== "string" || name.trim().length > 64) {
      return NextResponse.json({ error: "name required (<=64 chars)" }, { status: 400 });
    }
    const creatorWallet = session.wallets[0];
    if (!creatorWallet) {
      return NextResponse.json({ error: "Link a wallet to your login before creating a team." }, { status: 400 });
    }
    let team;
    try {
      team = await provisionTeam({ name: name.trim(), approverUserId: session.userId, recipients: [creatorWallet] });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
    }
    // The creator becomes founding owner immediately — otherwise they create
    // a team they can't act on (no membership = no invite/propose UI).
    await setOrgCreator(team.orgId, creatorWallet);
    try {
      await addMember(team.orgId, { did: session.userId, walletAddress: creatorWallet, role: "owner" });
    } catch {
      // already a member (retry path) — membership is what matters, not this write
    }
    const synced = await syncTeamToGateway(team.orgId);
    return NextResponse.json({
      org: { id: team.orgId, display_name: team.name },
      team,
      wallet: { id: team.walletId, address: team.walletAddress, policy_ids: [team.policyId] },
      teamSynced: synced.synced,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
