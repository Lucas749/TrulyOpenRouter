import { NextResponse } from "next/server";
import { privyApi } from "../../../../../../lib/privy-server";

/// @notice Attach a spending-cap policy to a wallet: create policy (owner = wallet owner quorum)
/// then assign it via policy_ids. Body: { ownerId, capWei, label? }.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { ownerId, capWei, label } = (await req.json().catch(() => ({}))) as {
      ownerId?: string;
      capWei?: string;
      label?: string;
    };
    if (!ownerId || !capWei) {
      return NextResponse.json({ error: "ownerId + capWei required" }, { status: 400 });
    }
    const policy: any = await privyApi("POST", "/policies", {
      version: "1.0",
      name: label ?? `tor-cap-${id.slice(0, 8)}`,
      chain_type: "ethereum",
      owner_id: ownerId,
      rules: [
        {
          name: "cap-send",
          method: "eth_sendTransaction",
          action: "ALLOW",
          conditions: [{ field_source: "ethereum_transaction", field: "value", operator: "lte", value: String(capWei) }],
        },
      ],
    });
    const wallet: any = await privyApi("PUT", `/wallets/${id}`, { policy_ids: [policy.id] });
    return NextResponse.json({ policy, wallet: { id: wallet.id, policy_ids: wallet.policy_ids } });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
