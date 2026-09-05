import { NextResponse } from "next/server";
import { newAuthKey, privyApi } from "../../../../lib/privy-server";

export async function GET() {
  try {
    const orgs: any = await privyApi("GET", "/organizations");
    return NextResponse.json({ data: orgs.data ?? orgs ?? [] });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

/// @notice Full team setup in one call: quorum (server key, threshold 1) -> org -> wallet.
/// Policies attach next (per-wallet guardrails); intents drive approvals after that.
export async function POST(req: Request) {
  try {
    const { name } = (await req.json().catch(() => ({}))) as { name?: string };
    if (!name || typeof name !== "string" || name.length > 64) {
      return NextResponse.json({ error: "name required (<=64 chars)" }, { status: 400 });
    }
    const quorum: any = await privyApi("POST", "/key_quorums", {
      public_keys: [newAuthKey()],
      authorization_threshold: 1,
      display_name: `${name}-admins`,
    });
    const org: any = await privyApi("POST", "/organizations", {
      display_name: name,
      default_key_quorum_id: quorum.id,
    });
    const wallet: any = await privyApi("POST", "/wallets", {
      entity: { id: org.id, type: "organization" },
      chain_type: "ethereum",
    });
    return NextResponse.json({ org, quorumId: quorum.id, wallet });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
