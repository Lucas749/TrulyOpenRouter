import { NextResponse } from "next/server";
import { getMember, memberByWallet, removeMember, roleRank, setMemberAllowance, setMemberRole, setMemberWallet, verifyActionMessage } from "../../../../../../../lib/members";
import type { Member, MemberRole } from "../../../../../../../lib/members";
import { clearCap, syncCap } from "../../../../../../../lib/gateway-admin";

/// @notice Rank-gated authorization: minRank 2 = owner-only (roles, removal),
/// minRank 1 = owner + manager (allowances). Returns the acting member.
async function requireMinRole(
  orgId: string,
  body: { signature?: string; message?: string; signerWallet?: string },
  bind: Record<string, string>,
  action: string,
  minRank: number,
): Promise<{ member: Member } | { error: NextResponse }> {
  if (!body.signature || !body.message || !body.signerWallet) {
    return { error: NextResponse.json({ error: "signature + message + signerWallet required" }, { status: 400 }) };
  }
  let signer: string;
  try {
    signer = await verifyActionMessage(body.message, body.signature, action, bind);
  } catch (e: any) {
    return { error: NextResponse.json({ error: `bad signature: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 401 }) };
  }
  const member = await memberByWallet(orgId, signer);
  if (!member || roleRank(member.role) < minRank) {
    return { error: NextResponse.json({ error: minRank >= 2 ? "signer is not an active owner" : "signer is not an owner or manager" }, { status: 403 }) };
  }
  return { member };
}

async function requireOwner(
  orgId: string,
  body: { signature?: string; message?: string; signerWallet?: string },
  bind: Record<string, string>,
  action: string,
): Promise<{ owner: Member } | { error: NextResponse }> {
  const r = await requireMinRole(orgId, body, bind, action, 2);
  return "error" in r ? r : { owner: r.member };
}

// PATCH: owner+manager sets allowance; owner-only sets role. Wallet-signed;
// allowance changes sync to gateway enforcement first.
export async function PATCH(req: Request, { params }: { params: Promise<{ orgId: string; did: string }> }): Promise<Response> {
  try {
    const { orgId, did } = await params;
    const targetDid = decodeURIComponent(did);
    const body = (await req.json().catch(() => ({}))) as {
      allowanceCredits?: number | null;
      role?: string;
      walletAddress?: string;
      signature?: string;
      message?: string;
      signerWallet?: string;
    };
    if (body.allowanceCredits === undefined && body.role === undefined && body.walletAddress === undefined) {
      return NextResponse.json({ error: "allowanceCredits and/or role and/or walletAddress required" }, { status: 400 });
    }
    if (body.allowanceCredits !== undefined && body.allowanceCredits !== null && (!Number.isFinite(body.allowanceCredits) || body.allowanceCredits < 0)) {
      return NextResponse.json({ error: "allowanceCredits must be a non-negative number or null (inherit)" }, { status: 400 });
    }
    if (body.role !== undefined && body.role !== "owner" && body.role !== "manager" && body.role !== "member") {
      return NextResponse.json({ error: "role must be owner|manager|member" }, { status: 400 });
    }
    const target = await getMember(orgId, targetDid);
    if (!target) return NextResponse.json({ error: "member not found" }, { status: 404 });
    // Role + wallet changes are owner-only; allowance changes are owner+manager.
    // Wallet rebinds bind the new wallet into the signed message.
    const ownerOnly = body.role !== undefined || body.walletAddress !== undefined;
    const bind: Record<string, string> = { orgId, did: targetDid };
    if (body.walletAddress !== undefined) bind.wallet = body.walletAddress.toLowerCase();
    const authed = ownerOnly
      ? await requireOwner(orgId, body, bind, "member-set")
      : await requireMinRole(orgId, body, bind, "member-set", 1);
    if ("error" in authed) return authed.error;
    // Role changes apply locally (no gateway surface); allowance changes sync first.
    // null = inherit org default -> clear any gateway override so nothing stale enforces.
    const newCap: number | null | undefined = body.allowanceCredits;
    if (newCap !== undefined && target.keyPrefix) {
      try {
        if (newCap === null) await clearCap(target.keyPrefix);
        else await syncCap(target.keyPrefix, newCap);
      } catch (e: any) {
        return NextResponse.json({ error: `gateway sync failed, nothing persisted: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 502 });
      }
    }
    if (body.allowanceCredits !== undefined) await setMemberAllowance(orgId, targetDid, body.allowanceCredits ?? undefined);
    if (body.walletAddress !== undefined) {
      try {
        await setMemberWallet(orgId, targetDid, body.walletAddress);
      } catch (e: any) {
        return NextResponse.json({ error: String(e?.message ?? e).slice(0, 160) }, { status: 409 });
      }
    }
    if (body.role) {
      try {
        await setMemberRole(orgId, targetDid, body.role as MemberRole);
      } catch (e: any) {
        return NextResponse.json({ error: String(e?.message ?? e).slice(0, 160) }, { status: 409 });
      }
    }
    return NextResponse.json({ member: await getMember(orgId, targetDid) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

// DELETE: owner removes a member (history kept, spend denied). Clears gateway cap.
export async function DELETE(req: Request, { params }: { params: Promise<{ orgId: string; did: string }> }): Promise<Response> {
  try {
    const { orgId, did } = await params;
    const targetDid = decodeURIComponent(did);
    const body = (await req.json().catch(() => ({}))) as { signature?: string; message?: string; signerWallet?: string };
    const target = await getMember(orgId, targetDid);
    if (!target) return NextResponse.json({ error: "member not found" }, { status: 404 });
    const authed = await requireOwner(orgId, body, { orgId, did: targetDid }, "member-remove");
    if ("error" in authed) return authed.error;
    if (target.keyPrefix) {
      try {
        await clearCap(target.keyPrefix);
      } catch (e: any) {
        return NextResponse.json({ error: `gateway sync failed, nothing persisted: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 502 });
      }
    }
    return NextResponse.json({ member: await removeMember(orgId, targetDid) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
