import { NextResponse } from "next/server";

// POST /api/security/taps/:id { action: verify|execute }.
// verify: backend scans Solana for the device memo tap -> approved.
// execute: approved-only -> Hedera call with the ring-held host key.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:4121";
    const token = process.env.GATEWAY_ADMIN_TOKEN ?? "";
    if (!token) return NextResponse.json({ error: "GATEWAY_ADMIN_TOKEN not configured" }, { status: 501 });
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    if (body.action !== "verify" && body.action !== "execute") {
      return NextResponse.json({ error: "action must be verify|execute" }, { status: 400 });
    }
    const r = await fetch(`${base}/api/admin/taps/${encodeURIComponent(id)}/${body.action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const d: any = await r.json().catch(() => ({}));
    return NextResponse.json(d, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
