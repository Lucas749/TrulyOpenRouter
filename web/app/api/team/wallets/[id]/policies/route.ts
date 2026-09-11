import { NextResponse } from "next/server";
import { privyApi } from "../../../../../../lib/privy-server";
import { visibleOrgIds } from "../../../../../../lib/members";
import { requireSession } from "../../../../../../lib/session";

/// @notice Read a team wallet's attached policies (names, rules) for members of
/// the owning organization only. Policy changes need quorum authorization.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  try {
    const { id } = await params;
    const wallet: any = await privyApi("GET", `/wallets/${id}`);
    const orgId = wallet.entity?.type === "organization" ? wallet.entity.id : null;
    if (!orgId || !(await visibleOrgIds(session)).has(orgId)) {
      return NextResponse.json({ error: "wallet not found" }, { status: 404 });
    }
    const policies: any[] = [];
    for (const pid of wallet.policy_ids ?? []) {
      try {
        policies.push(await privyApi("GET", `/policies/${pid}`));
      } catch {}
    }
    return NextResponse.json({ wallet: { id: wallet.id, address: wallet.address, policy_ids: wallet.policy_ids ?? [] }, policies });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
