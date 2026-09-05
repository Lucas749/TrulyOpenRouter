import { NextResponse } from "next/server";
import { authorizeIntent, getIntent } from "../../../../../lib/intents";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json(await getIntent(id));
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

/// @notice Approve with the server-held quorum key. Body: { quorumId }.
/// See lib/intents.ts — authorize payload pending Privy confirmation.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { quorumId } = (await req.json().catch(() => ({}))) as { quorumId?: string };
    if (!quorumId) return NextResponse.json({ error: "quorumId required" }, { status: 400 });
    return NextResponse.json(await authorizeIntent(id, quorumId));
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 300) }, { status: 502 });
  }
}
