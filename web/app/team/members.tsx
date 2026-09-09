"use client";

import { apiError } from "../../lib/api-error";
import { useCallback, useEffect, useState } from "react";
import { useSignMessage } from "@privy-io/react-auth";
import { approvalMessage, inviteClaimMessage, memberActionMessage, shortId, spendBarState } from "../../lib/member-messages";
import { MOCK_TEAM_MEMBERS, MOCK_TEAM_ORG, MOCK_TEAM_REQUESTS } from "../../lib/mock";

// Members & spend for one team org. Spend-org identity = the Privy org id.
// Every mutation is authorized by a Privy embedded-wallet personal_sign over a
// canonical message (member-messages.ts); the server recovers the signer and
// requires an active owner. Mock mode renders fixtures only, actions disabled.

// Mirrors GET members rows exactly (Anthropic-style resolved view).
interface Member {
  did: string;
  email: string | null;
  walletAddress: string | null;
  role: "owner" | "manager" | "member";
  status: "active" | "invited";
  keyPrefix: string | null;
  allowanceCredits: number | null;
  effectiveCredits: number | null; // null = unlimited
  spentCredits: number | null; // null = unwired (gateway down / no key)
  createdAt: number;
}

function toSpend(m: Member): { used: number; cap: number | null } | null {
  if (m.spentCredits === null) return null;
  return { used: m.spentCredits, cap: m.effectiveCredits };
}

// Mirrors lib/members.ts IncreaseRequest (server shape, no invented fields).
interface IncreaseRequest {
  id: string;
  orgId: string;
  memberDid: string;
  amountCredits: number;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  decidedByDid?: string;
  decisionSigner?: string;
}

function age(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function RoleChip({ role }: { role: string }) {
  if (role === "owner") {
    return <span className="rounded-full bg-black px-2.5 py-0.5 text-[11px] text-white">Owner</span>;
  }
  if (role === "manager") {
    return <span className="rounded-full bg-[#E7F5EE] px-2.5 py-0.5 text-[11px] text-[#0B7A5D]">Manager</span>;
  }
  return <span className="rounded-full border border-black/15 px-2.5 py-0.5 text-[11px] text-[#5D5D5D]">Member</span>;
}

// Prescribed roles (server-enforced, see lib/members.ts):
// Owner = everything · Manager = invite + allowances + approvals (no roles, no removals, no defaults) · Member = spend + request.
const ROLE_HELP: Record<string, string> = {
  owner: "everything, incl. managing owners",
  manager: "invite, allowances, approvals",
  member: "spend within cap, request increases",
};

function SpendBar({ spend }: { spend: { used: number; cap: number | null } | null }) {
  if (!spend) return <span className="font-mono text-xs text-[#8F8F8F]">—</span>;
  if (spend.cap === null) return <span className="font-mono text-xs tabular-nums text-[#5D5D5D]">{spend.used}/∞</span>;
  const { pct, state } = spendBarState(spend.used, spend.cap);
  const fill = state === "capped" ? "bg-[#B3261E]" : state === "warning" ? "bg-[#B7791F]" : "bg-black";
  return (
    <span className="flex min-w-[180px] flex-1 items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10">
        <span className={`block h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono text-xs tabular-nums text-[#5D5D5D]">
        {spend.used}/{spend.cap ?? "∞"}
        {state === "capped" && <span className="text-[#B3261E]"> capped</span>}
      </span>
    </span>
  );
}

export default function OrgMembers({
  orgId,
  me,
  mock,
}: {
  orgId: string;
  me: { did: string; wallet: string | null; email: string | null } | null;
  mock: boolean;
}) {
  const { signMessage } = useSignMessage();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [requests, setRequests] = useState<IncreaseRequest[] | null>(null);
  const [defCap, setDefCap] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // invite form
  const [invDid, setInvDid] = useState("");
  const [invWallet, setInvWallet] = useState("");
  const [invEmail, setInvEmail] = useState("");
  const [invRole, setInvRole] = useState<"owner" | "manager" | "member">("member");
  const [invCap, setInvCap] = useState("");
  // per-row edit
  const [editDid, setEditDid] = useState<string | null>(null);
  const [editCap, setEditCap] = useState("");
  const [bindDid, setBindDid] = useState<string | null>(null);
  const [bindWallet, setBindWallet] = useState("");
  const [confirmRm, setConfirmRm] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newDefault, setNewDefault] = useState("");
  const [reqAmount, setReqAmount] = useState("");

  const load = useCallback(async () => {
    if (mock) {
      setMembers(MOCK_TEAM_MEMBERS);
      setRequests(MOCK_TEAM_REQUESTS);
      setDefCap(MOCK_TEAM_ORG.defaultAllowanceCredits);
      return;
    }
    try {
      const [m, r] = await Promise.all([
        (await fetch(`/api/team/orgs/${orgId}/members`)).json(),
        (await fetch(`/api/team/orgs/${orgId}/requests`)).json(),
      ]);
      setMembers(m.members ?? []);
      setRequests(r.data ?? []);
      setDefCap(m.defaultAllowanceCredits ?? null);
    } catch {
      setMembers([]);
      setRequests([]);
    }
  }, [orgId, mock]);

  useEffect(() => {
    load();
  }, [load]);

  const sameWallet = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const isOwner = !!members?.some(
    (m) => m.role === "owner" && (m.did === me?.did || sameWallet(m.walletAddress, me?.wallet)),
  );
  const myMembership = members?.find((m) => m.did === me?.did || sameWallet(m.walletAddress, me?.wallet)) ?? null;
  // Pending email invite for my login address (matched client-side from the
  // Privy session; the server still requires my wallet signature to claim).
  const myInvite = !myMembership && me?.email
    ? members?.find((m) => m.status === "invited" && m.email?.toLowerCase() === me.email!.toLowerCase()) ?? null
    : null;
  // Managers share invite / cap / inbox powers; removal, defaults, and roles stay owner-only.
  // Empty org + connected wallet = founding flow (server bootstraps the first
  // member as owner): show invite even to non-members, or nobody could start.
  const canManage = isOwner || myMembership?.role === "manager";
  const canFound = (members?.length ?? 0) === 0 && !!me?.wallet;
  const canInvite = canManage || canFound;
  const myWallet = myMembership?.walletAddress ?? me?.wallet ?? null;

  async function sign(msg: string): Promise<string> {
    const r = await signMessage({ message: msg });
    return r.signature;
  }

  async function post(path: string, body: unknown, tag: string) {
    setBusy(tag);
    setErr(null);
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(d, r.status));
      await load();
      return d;
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 200));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function invite() {
    if (!invEmail.trim() || !myWallet) return;
    // Email-only (no wallet yet): server creates an "invited" row the invitee
    // claims on first login. With a wallet: immediate active member (wallet did).
    const emailOnly = !invWallet.trim();
    const did = emailOnly ? "" : invDid.trim() || `wallet:${invWallet.trim().toLowerCase()}`;
    const role = (members?.length ?? 0) === 0 ? "owner" : invRole; // first member founds as owner
    const expires = Date.now() + 300_000;
    const action = emailOnly ? "member-invite" : "member-add";
    const fields: Record<string, string> = emailOnly
      ? { orgId, email: invEmail.trim().toLowerCase(), role }
      : { orgId, did, wallet: invWallet.trim(), role };
    const message = memberActionMessage(action, fields, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e: any) {
      setErr(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      return;
    }
    const cap = invCap.trim() ? Number(invCap) : undefined;
    const d = await post(`/api/team/orgs/${orgId}/members`, {
      member: emailOnly
        ? { email: invEmail.trim(), role, allowanceCredits: cap }
        : { did, walletAddress: invWallet.trim(), email: invEmail.trim() || null, role, allowanceCredits: cap },
      signature,
      message,
      signerWallet: myWallet,
    }, "invite");
    if (d) {
      setInvDid("");
      setInvWallet("");
      setInvEmail("");
      setInvCap("");
    }
  }

  // Claim my own email invite: I prove wallet ownership; the server matches the
  // email and activates me. My login email comes from the Privy session.
  async function claimInvite(email: string) {
    if (!me?.wallet || !me?.did) return;
    const expires = Date.now() + 300_000;
    const message = inviteClaimMessage(orgId, email, me.did, me.wallet, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e: any) {
      setErr(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      return;
    }
    const d = await post(`/api/team/orgs/${orgId}/members/claim`, {
      email, did: me.did, walletAddress: me.wallet, signature, message,
    }, "claim");
    if (d) await load();
  }

  // Owner binds a wallet to an invited row (invitee shared it out-of-band).
  async function bindInvitedWallet(did: string) {
    if (!myWallet || !/^0x[0-9a-fA-F]{40}$/.test(bindWallet.trim())) {
      setErr("wallet must be 0x + 40 hex");
      return;
    }
    const expires = Date.now() + 300_000;
    const message = memberActionMessage("member-set", { orgId, did, wallet: bindWallet.trim().toLowerCase() }, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e: any) {
      setErr(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      return;
    }
    const r = await fetch(`/api/team/orgs/${orgId}/members/${encodeURIComponent(did)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: bindWallet.trim(), signature, message, signerWallet: myWallet }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) setErr(apiError(d, r.status).slice(0, 200));
    else {
      setBindDid(null);
      setBindWallet("");
      await load();
    }
  }

  async function saveCap(did: string) {
    if (!myWallet) return;
    const expires = Date.now() + 300_000;
    const message = memberActionMessage("member-set", { orgId, did }, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e: any) {
      setErr(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      return;
    }
    const r = await fetch(`/api/team/orgs/${orgId}/members/${encodeURIComponent(did)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowanceCredits: editCap.trim() === "" ? null : Number(editCap), signature, message, signerWallet: myWallet }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) setErr(apiError(d, r.status).slice(0, 200));
    else {
      setEditDid(null);
      await load();
    }
  }

  async function remove(did: string) {
    if (!myWallet) return;
    const expires = Date.now() + 300_000;
    const message = memberActionMessage("member-remove", { orgId, did }, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e: any) {
      setErr(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      return;
    }
    const r = await fetch(`/api/team/orgs/${orgId}/members/${encodeURIComponent(did)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature, message, signerWallet: myWallet }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) setErr(apiError(d, r.status).slice(0, 200));
    else {
      setConfirmRm(null);
      await load();
    }
  }

  async function requestIncrease() {
    if (!myMembership || !myMembership.walletAddress || !reqAmount.trim()) return;
    const amountCredits = Number(reqAmount);
    const expires = Date.now() + 300_000;
    // Must match the route's binding exactly: action + memberDid + amountCredits.
    const message = memberActionMessage("increase-request", { orgId, memberDid: myMembership.did, amountCredits: String(amountCredits) }, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e: any) {
      setErr(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      return;
    }
    const d = await post(`/api/team/orgs/${orgId}/requests`, {
      memberDid: myMembership.did,
      amountCredits,
      signature,
      message,
      signerWallet: myMembership.walletAddress,
    }, "request");
    if (d) setReqAmount("");
  }

  async function decide(req: IncreaseRequest, decision: "approve" | "deny") {
    if (!myWallet || !myMembership) return;
    const expires = Date.now() + 300_000;
    const message = approvalMessage({ id: req.id, orgId, memberDid: req.memberDid, amountCredits: req.amountCredits }, decision, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e: any) {
      setErr(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      return;
    }
    await post(`/api/team/orgs/${orgId}/requests/${req.id}`, {
      decision,
      signerWallet: myWallet,
      signature,
      message,
    }, `decide-${req.id}`);
  }

  async function saveDefault() {
    if (!myWallet || !newDefault.trim()) return;
    const expires = Date.now() + 300_000;
    const message = memberActionMessage("org-set-default", { orgId, default: String(Number(newDefault)) }, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e: any) {
      setErr(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      return;
    }
    const d = await post(`/api/team/orgs/${orgId}/members`, {
      setDefault: Number(newDefault),
      signature,
      message,
      signerWallet: myWallet,
    }, "default");
    if (d) setNewDefault("");
  }

  const pending = (requests ?? []).filter((r) => r.status === "pending");
  const decided = (requests ?? []).filter((r) => r.status !== "pending");

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#E5E5E0] px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Members & spend ({members?.length ?? "…"})</span>
        <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">
          org default {defCap === null ? "unlimited" : `${defCap} credits/member`}
        </span>
      </div>

      {(members ?? []).map((m) => {
        // Wallet-derived dids display as the address, not "wallet:0x…".
        const didLabel = m.did.startsWith("wallet:") ? m.did.slice("wallet:".length) : m.did.replace(/^did:privy:/, "");
        const initial = (m.email ?? didLabel).charAt(0).toUpperCase();
        const open = expanded === m.did;
        const spend = toSpend(m);
        const invited = m.status === "invited";
        return (
          <div key={m.did} className="flex flex-col gap-2 rounded-lg bg-[#F7F7F5] p-3">
            <button onClick={() => setExpanded(open ? null : m.did)} className="flex items-center gap-2.5 text-left">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black text-xs font-medium text-white">{initial}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{m.email ?? shortId(didLabel, 18)}</span>
                <span className="block truncate font-mono text-[11px] tabular-nums text-[#6E6E73]">
                  {invited ? "invited — no wallet yet" : spend === null ? "—" : spend.cap === null ? `${spend.used} credits used` : `${spend.used}/${spend.cap} credits`}
                </span>
              </span>
              <span className="shrink-0"><RoleChip role={m.role} /></span>
              {invited && <span className="shrink-0 rounded-full border border-dashed border-black/25 px-2 py-0.5 text-[11px] text-[#6E6E73]">invited</span>}
              <span className={`shrink-0 font-mono text-xs text-[#8F8F8F] transition-transform ${open ? "rotate-90" : ""}`}>›</span>
            </button>
            {open && (
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[38px] font-mono text-xs text-[#6E6E73]">
                  <span className="break-all">{m.did}</span>
                  {m.keyPrefix ? <span>key {shortId(m.keyPrefix, 8)}</span> : <span className="text-[#B3261E]">no key, headless only</span>}
                  {m.walletAddress && <span>{shortId(m.walletAddress, 10)}</span>}
                </div>
                {invited ? (
                  <div className="flex flex-wrap items-center gap-2 pl-[38px]">
                    <span className="text-[11px] text-[#6E6E73]">waiting on {m.email ?? "invitee"} — they claim it by logging in, or bind their wallet:</span>
                    {isOwner && !mock && (bindDid === m.did ? (
                      <>
                        <input value={bindWallet} onChange={(e) => setBindWallet(e.target.value)} placeholder="wallet 0x…" className="h-8 w-52 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-xs" />
                        <button onClick={() => bindInvitedWallet(m.did)} className="rounded-full bg-black px-3 py-1 text-[11px] text-white">Bind</button>
                        <button onClick={() => { setBindDid(null); setBindWallet(""); }} className="text-[11px] text-[#6E6E73] underline">cancel</button>
                      </>
                    ) : (
                      <button onClick={() => { setBindDid(m.did); setBindWallet(""); setConfirmRm(null); setEditDid(null); }} className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px]">Bind wallet</button>
                    ))}
                    {isOwner && !mock && (confirmRm === m.did ? (
                      <>
                        <button onClick={() => remove(m.did)} className="rounded-full bg-[#B3261E] px-3 py-1 text-[11px] text-white">Confirm rescind</button>
                        <button onClick={() => setConfirmRm(null)} className="text-[11px] text-[#6E6E73] underline">keep</button>
                      </>
                    ) : (
                      <button onClick={() => { setConfirmRm(m.did); setBindDid(null); }} className="text-[11px] text-[#6E6E73] underline">Rescind</button>
                    ))}
                  </div>
                ) : (
                <div className="pl-[38px]"><SpendBar spend={spend} /></div>
                )}
                {!invited && canManage && !mock && (
                  <div className="flex flex-wrap items-center gap-2 pl-[38px]">
                    {editDid === m.did ? (
                      <>
                        <input value={editCap} onChange={(e) => setEditCap(e.target.value)} placeholder="credits, empty = org default" className="h-8 w-52 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-xs" inputMode="numeric" />
                        <button onClick={() => saveCap(m.did)} className="rounded-full bg-black px-3 py-1 text-[11px] text-white">Save</button>
                        <button onClick={() => setEditDid(null)} className="text-[11px] text-[#6E6E73] underline">cancel</button>
                      </>
                    ) : confirmRm === m.did ? (
                      <>
                        <span className="text-[11px] text-[#B3261E]">Remove {shortId(m.did, 14)}? spend → 0 deny.</span>
                        <button onClick={() => remove(m.did)} className="rounded-full bg-[#B3261E] px-3 py-1 text-[11px] text-white">Confirm remove</button>
                        <button onClick={() => setConfirmRm(null)} className="text-[11px] text-[#6E6E73] underline">keep</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setEditDid(m.did); setEditCap(m.allowanceCredits === null ? "" : String(m.allowanceCredits)); setConfirmRm(null); }} className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px]">Edit cap</button>
                        {isOwner && (
                          <button onClick={() => { setConfirmRm(m.did); setEditDid(null); }} className="text-[11px] text-[#6E6E73] underline">Remove</button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      {members && !members.length && <p className="m-0 text-sm text-[#8F8F8F]">no members yet, invite the first below</p>}

      {myInvite && !mock && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-black/15 bg-white p-3">
          <span className="text-xs">You&apos;re invited as <span className="font-medium">{myInvite.email}</span> ({myInvite.role}, {myInvite.allowanceCredits ?? defCap ?? "default"} credits).</span>
          <button onClick={() => claimInvite(myInvite.email!)} disabled={busy === "claim" || !me?.wallet} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">
            {busy === "claim" ? "signing…" : "Accept invite"}
          </button>
          {!me?.wallet && <span className="text-[11px] text-[#B3261E]">connect your wallet to accept</span>}
        </div>
      )}

      {myMembership && myMembership.role !== "owner" && !mock && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-black/15 p-3">
          <span className="text-xs text-[#5D5D5D]">Need headroom?</span>
          <input value={reqAmount} onChange={(e) => setReqAmount(e.target.value)} placeholder="new cap in credits" className="h-8 w-40 rounded-lg border border-black/10 px-2.5 font-mono text-xs" inputMode="numeric" />
          <button onClick={requestIncrease} disabled={busy === "request" || !reqAmount.trim()} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">
            {busy === "request" ? "signing…" : "Request increase"}
          </button>
          <span className="font-mono text-[11px] text-[#8F8F8F]">you sign, owner approves</span>
        </div>
      )}

      {canInvite && !mock && (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-black/15 p-3">
          <span className="text-xs font-medium">{canFound && !canManage ? "No members yet — add yourself as founding owner" : "Invite by email — they join when they sign up"}</span>
          <div className="flex flex-wrap gap-2">
            <input value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder="email" className="h-8 min-w-[160px] flex-1 rounded-lg border border-black/10 px-2.5 text-xs" />
            <input value={invWallet} onChange={(e) => setInvWallet(e.target.value)} placeholder="wallet 0x… (optional, adds them immediately)" className="h-8 min-w-[160px] flex-1 rounded-lg border border-black/10 px-2.5 font-mono text-xs" />
          </div>
          <div className="flex flex-wrap gap-2">
            {!invWallet.trim() ? null : (
              <input value={invDid} onChange={(e) => setInvDid(e.target.value)} placeholder="Privy DID, optional (defaults to wallet)" className="h-8 min-w-[200px] flex-1 rounded-lg border border-black/10 px-2.5 font-mono text-xs" />
            )}
            <select value={invRole} onChange={(e) => setInvRole(e.target.value as "owner" | "manager" | "member")} title={ROLE_HELP[invRole]} className="h-8 rounded-lg border border-black/10 bg-white px-2 text-xs">
              <option value="member" title={ROLE_HELP.member}>Member</option>
              <option value="manager" title={ROLE_HELP.manager}>Manager</option>
              <option value="owner" title={ROLE_HELP.owner}>Owner</option>
            </select>
            <input value={invCap} onChange={(e) => setInvCap(e.target.value)} placeholder="cap, empty = default" className="h-8 w-36 rounded-lg border border-black/10 px-2.5 font-mono text-xs" inputMode="numeric" />
            <button onClick={invite} disabled={busy === "invite" || !invEmail.trim() || !myWallet} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">
              {busy === "invite" ? "signing…" : (members?.length ?? 0) === 0 ? "Add founding owner" : "Invite"}
            </button>
          </div>
          {(members?.length ?? 0) === 0 && <span className="text-[11px] text-[#6E6E73]">Empty team, your signature adds the first member as owner, no prior owner needed.</span>}
          {!myWallet && <span className="text-[11px] text-[#B3261E]">connect your wallet to sign invites</span>}
        </div>
      )}

      {isOwner && !mock && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-[#6E6E73]">default for new members</span>
          <input value={newDefault} onChange={(e) => setNewDefault(e.target.value)} placeholder="credits" className="h-8 w-28 rounded-lg border border-black/10 px-2.5 font-mono text-xs" inputMode="numeric" />
          <button onClick={saveDefault} disabled={busy === "default" || !newDefault.trim()} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">
            {busy === "default" ? "signing…" : "Set default"}
          </button>
        </div>
      )}

      {(pending.length > 0 || decided.length > 0) && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Increase requests ({pending.length} pending)</span>
          {pending.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#FDF3E2] px-3 py-2">
              <span className="font-mono text-xs">{shortId(r.memberDid, 16)}</span>
              <span className="font-mono text-xs font-medium tabular-nums">→ {r.amountCredits} credits</span>
              <span className="font-mono text-[11px] text-[#8A5300]">{age(r.createdAt)}</span>
              {canManage && !mock ? (
                <span className="ml-auto flex gap-2">
                  <button onClick={() => decide(r, "approve")} disabled={busy === `decide-${r.id}`} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">
                    {busy === `decide-${r.id}` ? "signing…" : "Approve"}
                  </button>
                  <button onClick={() => decide(r, "deny")} disabled={busy === `decide-${r.id}`} className="rounded-full border border-black/15 px-3 py-1 text-[11px] disabled:opacity-40">Deny</button>
                </span>
              ) : (
                <span className="ml-auto rounded-full bg-[#FDF3E2] px-2.5 py-0.5 text-[11px] text-[#8A5300]">pending</span>
              )}
            </div>
          ))}
          {decided.slice(0, 5).map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-[#6E6E73]">
              <span>{shortId(r.memberDid, 16)}</span>
              <span className={r.status === "approved" ? "text-[#0B7A5D]" : "text-[#B3261E]"}>{r.status} → {r.amountCredits}</span>
              {r.decisionSigner && <span>signed {shortId(r.decisionSigner, 8)}</span>}
            </div>
          ))}
        </div>
      )}
      {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
    </div>
  );
}
