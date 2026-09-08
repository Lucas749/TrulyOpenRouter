import { NextResponse } from "next/server";
import { getProfile, saveProfile } from "../../../lib/profiles";

// Display name for UI only (headers, labels). Client-claimed wallet identity:
// fine for your own label, never authorization.
// GET ?wallet=0x… -> { profile | null }; POST { wallet, displayName } -> { profile }.
export async function GET(req: Request): Promise<Response> {
  try {
    const wallet = new URL(req.url).searchParams.get("wallet") ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return NextResponse.json({ profile: null });
    return NextResponse.json({ profile: await getProfile(wallet) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { wallet?: string; displayName?: string };
    if (!body.wallet || !/^0x[0-9a-fA-F]{40}$/.test(body.wallet)) {
      return NextResponse.json({ error: "wallet must be 0x + 40 hex" }, { status: 400 });
    }
    if (typeof body.displayName !== "string" || !body.displayName.trim()) {
      return NextResponse.json({ error: "displayName required" }, { status: 400 });
    }
    return NextResponse.json({ profile: await saveProfile(body.wallet, body.displayName.trim()) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
