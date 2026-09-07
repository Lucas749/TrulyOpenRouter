import { NextResponse } from "next/server";

// Security tap queue passthrough. The browser never touches the gateway admin
// token or the device command flow directly — this route injects
// GATEWAY_ADMIN_TOKEN server-side and relays. Owner-gating happens in the UI
// layer (team owners); the gateway additionally requires its admin token.

function gateway(): { base: string; token: string } | null {
  const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:4121";
  const token = process.env.GATEWAY_ADMIN_TOKEN ?? "";
  if (!token) return null;
  return { base, token };
}

// GET: list taps (optionally ?status=pending|approved|executed|failed).
export async function GET(req: Request): Promise<Response> {
  try {
    const g = gateway();
    if (!g) return NextResponse.json({ error: "GATEWAY_ADMIN_TOKEN not configured" }, { status: 501 });
    const status = new URL(req.url).searchParams.get("status");
    const r = await fetch(`${g.base}/api/admin/taps${status ? `?status=${encodeURIComponent(status)}` : ""}`, {
      headers: { Authorization: `Bearer ${g.token}` },
    });
    const d: any = await r.json().catch(() => ({}));
    return NextResponse.json(d, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

// POST: queue a tap { kind: heartbeat|stake-release, params? }.
// Returns the tap + the exact device command the owner runs on their Ledger.
export async function POST(req: Request): Promise<Response> {
  try {
    const g = gateway();
    if (!g) return NextResponse.json({ error: "GATEWAY_ADMIN_TOKEN not configured" }, { status: 501 });
    const body = (await req.json().catch(() => ({}))) as { kind?: string; params?: Record<string, string> };
    if (!body.kind) return NextResponse.json({ error: "kind required" }, { status: 400 });
    const r = await fetch(`${g.base}/api/admin/taps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: body.kind, params: body.params ?? {} }),
    });
    const d: any = await r.json().catch(() => ({}));
    return NextResponse.json(d, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
