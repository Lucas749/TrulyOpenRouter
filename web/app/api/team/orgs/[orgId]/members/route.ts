import { NextResponse } from "next/server";
import {
  addMember,
  effectiveAllowance,
  ensureOrg,
  getOrgMeta,
  inviteMember,
  memberByWallet,
  spendCapFor,
  periodStartFor,
  removeMember,
  roleRank,
  setOrgDefault,
  verifyActionMessage,
} from "../../../../../../lib/members";
import { clearCap, keyOwner, syncCap, syncSpendCap } from "../../../../../../lib/gateway-admin";
import { requireSession, requireTeamViewer, sessionOwnsWallet, walletNotLinked } from "../../../../../../lib/session";
import { syncTeamToGateway } from "../../../../../../lib/team-sync";

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
export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  try {
    const { orgId } = await params;
    const session = await requireTeamViewer(req, orgId);
    if (session instanceof Response) return session;
    const meta = await getOrgMeta(orgId);
    if (!meta) return NextResponse.json({ error: "team not found" }, { status: 404 });
    const rows = await Promise.all(
      meta.members
        .filter((m) => m.status !== "removed")
        .map(async (m) => ({
          did: m.did,
          email: m.email ?? null,
          walletAddress: m.walletAddress || null,
          role: m.role,
          status: m.status,
          keyPrefix: m.keyPrefix ?? null,
          allowanceCredits: m.allowanceCredits ?? null,
          effectiveCredits: effectiveAllowance(meta, m.did) === Infinity ? null : effectiveAllowance(meta, m.did),
          spentCredits: m.status === "active" ? await gatewaySpend(m.keyPrefix) : null,
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

// POST: owner adds a member. Owner proves it with a wallet personal_sign from a
// wallet linked to their login; the creator of an ownerless org may found it once.
export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
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
      if (!sessionOwnsWallet(session, signer)) return walletNotLinked();
      const meta = await getOrgMeta(orgId);
      const owner = meta?.members.find((m) => m.role === "owner" && m.status === "active" && m.walletAddress.toLowerCase() === signer.toLowerCase());
      if (!owner) return NextResponse.json({ error: "signer is not an active owner" }, { status: 403 });
      // A lower default can reduce every inheriting member: the gateway sees it first.
      const preview = await syncTeamToGateway(orgId, (members) => ({ members, defaultAllowanceCredits: Number(body.setDefault) }));
      if (preview.error) {
        return NextResponse.json({ error: `gateway team sync failed, nothing persisted: ${preview.error}` }, { status: 502 });
      }
      const updated = await setOrgDefault(orgId, Number(body.setDefault));
      const team = await syncTeamToGateway(orgId);
      // Fan-out: members inheriting the default (no explicit allowance) get a
      // new effective cap — mirror each onchain, best-effort, counted.
      const metaAfter = await getOrgMeta(orgId);
      const inheriting = (metaAfter?.members ?? []).filter(
        (x) => x.status === "active" && x.allowanceCredits === undefined && (x.walletAddress || x.keyPrefix),
      );
      const chain: Record<string, number> = { synced: 0, skipped: 0, failed: 0 };
      await Promise.all(
        inheriting.map(async (x) => {
          const { capCredits, periodDays } = spendCapFor(metaAfter!, x.did);
          const r = await syncSpendCap({ address: x.walletAddress || undefined, prefix: x.keyPrefix ?? undefined, capCredits, periodDays });
          chain[r] += 1;
        }),
      );
      return NextResponse.json({ defaultAllowanceCredits: updated.defaultAllowanceCredits ?? null, chainSynced: chain, teamSynced: team.synced });
    }
    // Email-only invite: no wallet yet. Owner/manager signs action "member-invite"
    // binding {orgId, email, role}; the invitee claims it on first login by
    // proving wallet ownership (POST members/claim). Invites are member|manager.
    if (body.member?.email && !body.member?.walletAddress && !body.member?.did) {
      const email = body.member.email.trim().toLowerCase();
      const bootMeta = await ensureOrg(orgId);
      const bootstrapping = !bootMeta.members.some((m) => m.role === "owner" && m.status === "active");
      const requested = bootstrapping ? "owner" : body.member.role === "manager" ? "manager" : "member";
      if (!body.signature || !body.message || !body.signerWallet) {
        return NextResponse.json({ error: "signature + message + signerWallet required" }, { status: 400 });
      }
      let signer: string;
      try {
        signer = await verifyActionMessage(body.message, body.signature, "member-invite", {
          orgId,
          email,
          role: requested,
        });
      } catch (e: any) {
        return NextResponse.json({ error: `bad signature: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 401 });
      }
      if (!sessionOwnsWallet(session, signer)) return walletNotLinked();
      if (bootstrapping) {
        if (!bootMeta.creatorWallet || !sessionOwnsWallet(session, bootMeta.creatorWallet)) {
          return NextResponse.json({ error: "only the team creator can found an ownerless team" }, { status: 403 });
        }
      } else {
        const authed = await memberByWallet(orgId, signer);
        if (!authed || roleRank(authed.role) < 1) {
          return NextResponse.json({ error: "signer is not an owner or manager" }, { status: 403 });
        }
        if (roleRank(requested) > roleRank(authed.role)) {
          return NextResponse.json({ error: "cannot grant a role above your own" }, { status: 403 });
        }
      }
      try {
        const inv = await inviteMember(orgId, {
          email,
          role: requested as "owner" | "manager" | "member",
          allowanceCredits: body.member.allowanceCredits,
        });
        // No wallet yet = nothing to cap onchain; the claim mirrors then.
        const team = await syncTeamToGateway(orgId);
        return NextResponse.json({ member: inv, invited: true, chainSynced: "skipped", teamSynced: team.synced });
      } catch (e: any) {
        return NextResponse.json({ error: String(e?.message ?? e).slice(0, 160) }, { status: 409 });
      }
    }
    // did is optional: owners invite by email + wallet, and the did defaults to
    // wallet:<address>. Login matching already works by wallet, so invited members
    // just work when they log in — no Privy DID archaeology required.
    const did = body.member?.did?.trim() || `wallet:${String(body.member?.walletAddress ?? "").toLowerCase()}`;
    if (!body.member?.walletAddress || !body.signature || !body.message || !body.signerWallet) {
      return NextResponse.json({ error: "member {walletAddress} + signature + message + signerWallet required" }, { status: 400 });
    }
    const rollback = async (did: string) => {
      try {
        await removeMember(orgId, did);
      } catch {}
    };
    const failSync = (did: string, e: any) =>
      NextResponse.json({ error: `gateway sync failed, nothing persisted: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 502 });

    const meta = await ensureOrg(orgId);
    const owners = meta.members.filter((m) => m.role === "owner" && m.status === "active");
    const bootstrapping = owners.length === 0;
    // Bootstrap: first member claims founding ownership (role forced, locked after).
    // Otherwise the signer needs rank 1+ (manager) and can only grant roles at or
    // below their own — managers can't mint owners.
    const requested = body.member.role === "owner" || body.member.role === "manager" ? body.member.role : "member";
    const role = bootstrapping ? "owner" : requested;
    let signer: string;
    try {
      signer = await verifyActionMessage(body.message, body.signature, "member-add", {
        orgId,
        did,
        wallet: body.member.walletAddress,
        role,
      });
    } catch (e: any) {
      return NextResponse.json({ error: `bad signature: ${String(e?.message ?? e).slice(0, 120)}` }, { status: 401 });
    }
    if (!sessionOwnsWallet(session, signer)) return walletNotLinked();
    if (bootstrapping) {
      // Signer must BE the member they register — no claiming wallets for others —
      // and only the verified creator may found an ownerless team.
      if (signer.toLowerCase() !== String(body.member.walletAddress).toLowerCase()) {
        return NextResponse.json({ error: "signer must match the registered wallet" }, { status: 403 });
      }
      if (!meta.creatorWallet || !sessionOwnsWallet(session, meta.creatorWallet)) {
        return NextResponse.json({ error: "only the team creator can found an ownerless team" }, { status: 403 });
      }
    } else {
      const authed = await memberByWallet(orgId, signer);
      if (!authed || roleRank(authed.role) < 1) {
        return NextResponse.json({ error: "signer is not an owner or manager" }, { status: 403 });
      }
      if (roleRank(requested) > roleRank(authed.role)) {
        return NextResponse.json({ error: "cannot grant a role above your own" }, { status: 403 });
      }
    }
    // Key prefixes are public in receipts, and a bound key gets this team's caps.
    // Bind only an active key issued by the member's own login.
    if (body.member.keyPrefix !== undefined) {
      let key;
      try {
        key = await keyOwner(String(body.member.keyPrefix));
      } catch (e) {
        return NextResponse.json({ error: String((e as Error)?.message ?? e).slice(0, 160) }, { status: 502 });
      }
      const login = (id: string) => id.replace(/^did:privy:/, "");
      if (!key || key.revoked || !key.ownerUserId || login(key.ownerUserId) !== login(did)) {
        return NextResponse.json({ error: "bind only an active API key issued by this member's own login" }, { status: 403 });
      }
    }
    let m;
    try {
      m = await addMember(orgId, {
        did,
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
        await rollback(m.did);
        return failSync(m.did, e);
      }
    }
    // Onchain mirror of the EFFECTIVE allowance (explicit or inherited default;
    // null = uncapped, which also clears stale caps on re-invite revive).
    // Best-effort: reported, never blocks membership.
    const metaAfter = await ensureOrg(orgId);
    const { capCredits, periodDays } = spendCapFor(metaAfter, m.did);
    const chainSync = await syncSpendCap({
      address: m.walletAddress || undefined,
      prefix: m.keyPrefix ?? undefined,
      capCredits,
      periodDays,
    });
    // New access reaches the gateway after it is stored (fail closed until synced).
    const team = await syncTeamToGateway(orgId);
    return NextResponse.json({ member: m, bootstrappedOwner: bootstrapping, chainSynced: chainSync, teamSynced: team.synced });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
