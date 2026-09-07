import { NextResponse } from "next/server";
import { getMember, getOrgMeta, removeMember, setMemberAllowance, setMemberRole, verifyActionMessage } from "../../../../../../../lib/members";
import type { Member } from "../../../../../../../lib/members";
import { clearCap, syncCap } from "../../../../../../../lib/gateway-admin";

async function requireOwner(
  orgId: string,
  body: { signature?: string; message?: string; signerWallet?: string },
  bind: Record<string, string>,
  action: string,
): Promise<{ owner: Member } | { error: NextResponse }> {
  if (!body.signature || !body.message || !body.signerWallet) {
    return { error: NextResponse.json({ error: "signature + message + signerWallet required" }, { status: 400 }) };
  }
  let signer: string;
  try {
    signer = await verifyActionMessage(body.message, body.signature, action, bind);
  } catch (e: any) {
    return { error: NextResponse.json({ error: `bad signature: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 401 }) };
  }
  const meta = await getOrgMeta(orgId);
  const owner = meta?.members.find((m) => m.role === "owner" && m.status === "active" && m.walletAddress.toLowerCase() === signer.toLowerCase());
  if (!owner) return { error: NextResponse.json({ error: "signer is not an active owner" }, { status: 403 }) };
  return { owner };
}

// PATCH: owner sets allowance and/or role. Wallet-signed; synced to gateway enforcement.
export async function PATCH(req: Request, { params }: { params: Promise<{ orgId: string; did: string }> }): Promise<Response> {
  try {
    const { orgId, did } = await params;
    const targetDid = decodeURIComponent(did);
    const body = (await req.json().catch(() => ({}))) as {
      allowanceCredits?: number | null;
      role?: string;
      signature?: string;
      message?: string;
      signerWallet?: string;
    };
    if (body.allowanceCredits === undefined && body.role === undefined) {
      return NextResponse.json({ error: "allowanceCredits and/or role required" }, { status: 400 });
    }
    if (body.allowanceCredits !== undefined && body.allowanceCredits !== null && (!Number.isFinite(body.allowanceCredits) || body.allowanceCredits < 0)) {
      return NextResponse.json({ error: "allowanceCredits must be a non-negative number or null (inherit)" }, { status: 400 });
    }
    if (body.role !== undefined && body.role !== "owner" && body.role !== "member") {
      return NextResponse.json({ error: "role must be owner|member" }, { status: 400 });
    }
    const target = await getMember(orgId, targetDid);
    if (!target) return NextResponse.json({ error: "member not found" }, { status: 404 });
    const authed = await requireOwner(orgId, body, { orgId, did: targetDid }, "member-set");
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
    if (body.role) {
      try {
        await setMemberRole(orgId, targetDid, body.role as "owner" | "member");
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
