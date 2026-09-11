import { NextResponse } from "next/server";
import { newAuthKeypair, privyApi } from "../../../../lib/privy-server";
import { saveQuorumKey } from "../../../../lib/quorum-keys";
import { visibleOrgIds } from "../../../../lib/members";
import { requireSession } from "../../../../lib/session";

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  try {
    const orgs: any = await privyApi("GET", "/organizations");
    const list: any[] = orgs.data ?? orgs ?? [];
    const wallets: any = await privyApi("GET", "/wallets").catch(() => ({ data: [] }));
    const all: any[] = wallets.data ?? [];
    // Only orgs this login created, belongs to, or is invited to. There is no
    // unfiltered listing: identity comes from the verified token.
    const visible = await visibleOrgIds(session);
    return NextResponse.json({
      data: list
        .filter((o: any) => visible.has(o.id))
        .map((o: any) => ({
          ...o,
          wallets: all
            .filter((w: any) => w.entity?.id === o.id)
            .map((w: any) => ({ id: w.id, address: w.address, policy_ids: w.policy_ids ?? [] })),
        })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

/// @notice Full team setup in one call: quorum (server key, threshold 1) -> org -> wallet.
/// Optional capUsd attaches a spending-cap policy AT CREATION in USD terms,
/// converted to native (HBAR) wei at the indicative rate in lib/fx.ts — our
/// chain's native token IS HBAR, so the policy covers HBAR sends by construction.
/// (Legacy capWei passthrough kept for compat.) The verified login becomes the
/// founding owner; later policy changes need quorum authorization signatures.
export async function POST(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  try {
    const { name, capWei, capUsd } = (await req.json().catch(() => ({}))) as {
      name?: string;
      capWei?: string;
      capUsd?: number;
    };
    if (!name || typeof name !== "string" || name.length > 64) {
      return NextResponse.json({ error: "name required (<=64 chars)" }, { status: 400 });
    }
    const creatorWallet = session.wallets[0];
    if (!creatorWallet) {
      return NextResponse.json({ error: "Link a wallet to your login before creating a team." }, { status: 400 });
    }
    let cap = capWei;
    if (capUsd !== undefined) {
      const { usdToHbarWei } = await import("../../../../lib/fx");
      try {
        cap = usdToHbarWei(Number(capUsd));
      } catch {
        return NextResponse.json({ error: "capUsd must be a positive number" }, { status: 400 });
      }
    }
    const { publicKey, privateKey } = newAuthKeypair();
    const quorum: any = await privyApi("POST", "/key_quorums", {
      public_keys: [publicKey],
      authorization_threshold: 1,
      display_name: `${name}-admins`,
    });
    // Server holds this key -> one-click approvals below. Pre-store orgs lack it (see quorum-keys.ts).
    await saveQuorumKey(quorum.id, privateKey);
    const org: any = await privyApi("POST", "/organizations", {
      display_name: name,
      default_key_quorum_id: quorum.id,
    });
    let policy: any = null;
    const walletBody: any = { entity: { id: org.id, type: "organization" }, chain_type: "ethereum" };
    if (cap) {
      policy = await privyApi("POST", "/policies", {
        version: "1.0",
        name: `${name}-cap`,
        chain_type: "ethereum",
        owner_id: quorum.id,
        rules: [
          {
            name: "cap-send",
            method: "eth_sendTransaction",
            action: "ALLOW",
            conditions: [{ field_source: "ethereum_transaction", field: "value", operator: "lte", value: String(cap) }],
          },
        ],
      });
      walletBody.policy_ids = [policy.id];
    }
    const wallet: any = await privyApi("POST", "/wallets", walletBody);
    // The creator becomes founding owner immediately — otherwise they create
    // a team they can't act on (no membership = no invite/propose UI).
    const { addMember, setOrgCreator } = await import("../../../../lib/members");
    await setOrgCreator(org.id, creatorWallet);
    try {
      await addMember(org.id, { did: session.userId, walletAddress: creatorWallet, role: "owner" });
    } catch {
      // already a member (retry path) — membership is what matters, not this write
    }
    const { syncTeamToGateway } = await import("../../../../lib/team-sync");
    const team = await syncTeamToGateway(org.id);
    return NextResponse.json({ org, quorumId: quorum.id, policy, wallet, teamSynced: team.synced });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
