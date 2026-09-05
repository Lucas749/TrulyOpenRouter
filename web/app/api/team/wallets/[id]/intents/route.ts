import { NextResponse } from "next/server";
import { authorizeIntent, getIntent, proposeSignIntent } from "../../../../../../lib/intents";

/// @notice Propose a sign intent on a team wallet (sign-only: proves the approval loop
/// without depending on Privy broadcast support for custom chains).
/// Body: { to, valueWeiHex, chainId? } — defaults to a 0-value self-send on Hedera testnet.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { to, valueWeiHex, chainId } = (await req.json().catch(() => ({}))) as {
      to?: string;
      valueWeiHex?: string;
      chainId?: number;
    };
    const intent = await proposeSignIntent(id, {
      to: to ?? "0x0000000000000000000000000000000000000000",
      value: valueWeiHex ?? "0x0",
      chainId: chainId ?? 296,
    });
    return NextResponse.json(intent);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
