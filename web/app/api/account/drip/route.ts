import { NextResponse } from "next/server";

// POST /api/account/drip { address } — create the user's Hedera account with
// 0.5 operator HBAR (auto-creation on first transfer). Gateway enforces
// only-if-nonexistent, so each address drips once. The 10 HBAR subscribe
// still needs the faucet; this just guarantees a pasteable 0.0.x id.
export async function POST(req: Request): Promise<Response> {
  try {
    const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:4121";
    const token = process.env.GATEWAY_ADMIN_TOKEN ?? "";
    if (!token) return NextResponse.json({ error: "GATEWAY_ADMIN_TOKEN not configured" }, { status: 501 });
    const body = (await req.json().catch(() => ({}))) as { address?: string };
    if (!body.address || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      return NextResponse.json({ error: "address must be 0x + 40 hex" }, { status: 400 });
    }
    const r = await fetch(`${base}/api/admin/drip`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ address: body.address }),
    });
    const d: any = await r.json().catch(() => ({}));
    return NextResponse.json(d, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
