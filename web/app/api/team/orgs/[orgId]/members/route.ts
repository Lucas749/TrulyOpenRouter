import { NextResponse } from "next/server";
import {
  addMember,
  effectiveAllowance,
  ensureOrg,
  getOrgMeta,
  periodStartFor,
  removeMember,
  setOrgDefault,
  verifyActionMessage,
} from "../../../../../../lib/members";
import { clearCap, syncCap } from "../../../../../../lib/gateway-admin";

async function gatewaySpend(prefix: string | undefined): Promise<number | null> {
  if (!prefix) return null;
  try {
    const base = process.env.GATEWAY_URL ?? process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:4021";
    const r = await fetch(`${base}/api/usage/key:${encodeURIComponent(prefix)}`);
    if (!r.ok) return null;
    const d: any = await r.json();
    return typeof d.spent === "number" ? d.spent : null;
  } catch {
    return null; // gateway down: show allowance without spend, never fake it
  }
}

// GET: members with live spend + effective caps (Anthropic-style resolved view).
export async function GET(_req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const { orgId } = await params;
    const meta = getOrgMeta(orgId) ?? ensureOrg(orgId);
    const rows = await Promise.all(
      meta.members
        .filter((m) => m.status === "active")
        .map(async (m) => ({
          did: m.did,
          email: m.email ?? null,
          walletAddress: m.walletAddress,
          role: m.role,
          keyPrefix: m.keyPrefix ?? null,
          allowanceCredits: m.allowanceCredits ?? null,
          effectiveCredits: effectiveAllowance(meta, m.did) === Infinity ? null : effectiveAllowance(meta, m.did),
          spentCredits: await gatewaySpend(m.keyPrefix),
          periodStart: periodStartFor(meta, m.did),
          periodDays: meta.periodDays,
          createdAt: m.createdAt,
        })),
    );
    return NextResponse.json({
      orgId,
      defaultAllowanceCredits: meta.defaultAllowanceCredits ?? null,
      periodDays: meta.periodDays,
      members: rows,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

// POST: owner adds a member. Owner proves it with a wallet personal_sign; first
// member of an ownerless org becomes founding owner (one-time bootstrap, locked after).
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const { orgId } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      member?: { did?: string; email?: string; walletAddress?: string; role?: string; keyPrefix?: string; allowanceCredits?: number };
      setDefault?: number;
      signature?: string;
      message?: string;
      signerWallet?: string;
    };
    // Org-default update: owner-signed, no member payload. The client signs
    // action "org-set-default" binding {orgId, default}.
    if (body.setDefault !== undefined && !body.member) {
      if (!body.signature || !body.message || !body.signerWallet) {
        return NextResponse.json({ error: "signature + message + signerWallet required" }, { status: 400 });
      }
      let signer: string;
      try {
        signer = await verifyActionMessage(body.message, body.signature, "org-set-default", {
          orgId,
          default: String(Number(body.setDefault)),
        });
      } catch (e: any) {
        return NextResponse.json({ error: `bad signature: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 401 });
      }
      const meta = getOrgMeta(orgId);
      const owner = meta?.members.find((m) => m.role === "owner" && m.status === "active" && m.walletAddress.toLowerCase() === signer.toLowerCase());
      if (!owner) return NextResponse.json({ error: "signer is not an active owner" }, { status: 403 });
      const updated = setOrgDefault(orgId, Number(body.setDefault));
      return NextResponse.json({ defaultAllowanceCredits: updated.defaultAllowanceCredits ?? null });
    }
    if (!body.member?.did || !body.member?.walletAddress || !body.signature || !body.message || !body.signerWallet) {
      return NextResponse.json({ error: "member {did, walletAddress} + signature + message + signerWallet required" }, { status: 400 });
    }
    const rollback = (did: string) => {
      try {
        removeMember(orgId, did);
      } catch {}
    };
    const failSync = (did: string, e: any) =>
      NextResponse.json({ error: `gateway sync failed, nothing persisted: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 502 });

    const meta = ensureOrg(orgId);
    const owners = meta.members.filter((m) => m.role === "owner" && m.status === "active");
    const bootstrapping = owners.length === 0;
    // Bootstrap: first member claims founding ownership (role forced, locked after).
    // Otherwise the signer must be an active owner.
    const role = bootstrapping ? "owner" : body.member.role === "owner" ? "owner" : "member";
    let signer: string;
    try {
      signer = await verifyActionMessage(body.message, body.signature, "member-add", {
        orgId,
        did: body.member.did,
        wallet: body.member.walletAddress,
        role,
      });
    } catch (e: any) {
      return NextResponse.json({ error: `bad signature: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 401 });
    }
    if (bootstrapping) {
      // Signer must BE the member they register — no claiming wallets for others.
      if (signer.toLowerCase() !== String(body.member.walletAddress).toLowerCase()) {
        return NextResponse.json({ error: "signer must match the registered wallet" }, { status: 403 });
      }
    } else if (!owners.some((o) => o.walletAddress.toLowerCase() === signer.toLowerCase())) {
      return NextResponse.json({ error: "signer is not an active owner" }, { status: 403 });
    }
    let m;
    try {
      m = addMember(orgId, {
        did: body.member.did,
        email: body.member.email,
        walletAddress: body.member.walletAddress,
        role,
        keyPrefix: body.member.keyPrefix,
        allowanceCredits: body.member.allowanceCredits,
      });
    } catch (e: any) {
      return NextResponse.json({ error: String(e?.message ?? e).slice(0, 160) }, { status: 409 });
    }
    if (m.allowanceCredits !== undefined && m.keyPrefix) {
      try {
        await syncCap(m.keyPrefix, m.allowanceCredits);
      } catch (e: any) {
        rollback(m.did);
        return failSync(m.did, e);
      }
    }
    return NextResponse.json({ member: m, bootstrappedOwner: bootstrapping });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
