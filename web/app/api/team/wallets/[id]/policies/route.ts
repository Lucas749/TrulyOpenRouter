import { NextResponse } from "next/server";
import { privyApi } from "../../../../../../lib/privy-server";

/// @notice Read a wallet's attached policies (names, rules). Policy CHANGES need quorum
/// authorization signatures (roadmap) — attach happens at wallet creation instead.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const wallet: any = await privyApi("GET", `/wallets/${id}`);
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
