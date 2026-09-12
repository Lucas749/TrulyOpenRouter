"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSignMessage } from "@privy-io/react-auth";
import { apiError } from "../../lib/api-error";
import { useAuthFetch } from "../components/use-auth-fetch";
import { approvalMessage, inviteClaimMessage, memberActionMessage, shortId, spendBarState } from "../../lib/member-messages";
import { MOCK_TEAM_MEMBERS, MOCK_TEAM_ORG, MOCK_TEAM_REQUESTS } from "../../lib/mock";

// Seats and allowances for one team org. Spend-org identity = the Privy org id.
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

const fmt = (n: number) => n.toLocaleString("en-US");
const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
// Module scope on purpose: the signed messages carry a clock reading, which must not be
// read from component render code.
const expiry = (): number => Date.now() + 300_000;

const ROLE_STYLE: Record<string, string> = {
  owner: "bg-[#0D0D0D] text-white",
  manager: "bg-[#F4F4F4] text-[#0D0D0D]",
  member: "bg-[#F4F4F4] text-[#424242]",
};
// Prescribed roles (server-enforced, see lib/members.ts):
// Owner = everything · Manager = invite + allowances + approvals · Member = spend + request.
const ROLE_HELP: Record<string, string> = {
  owner: "everything, incl. managing owners",
  manager: "invite, allowances, approvals",
  member: "spend within cap, request increases",
};

const Glyph = ({ d, size = 15 }: { d: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const SAVED = (
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </>
);

const small = "h-7 shrink-0 rounded-full border border-[#E5E5E0] bg-white px-[11px] text-[12px] text-[#424242] transition-colors hover:bg-[#F4F4F4] disabled:opacity-40";
const cell = "h-[34px] w-24 rounded-[10px] border bg-white px-2.5 text-right font-mono text-[13px] tabular-nums text-[#0D0D0D] outline-none transition-colors focus:border-black/40";

function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
  const authFetch = useAuthFetch();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [requests, setRequests] = useState<IncreaseRequest[] | null>(null);
  const [defCap, setDefCap] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // invite row
  const [invEmail, setInvEmail] = useState("");
  const [invWallet, setInvWallet] = useState("");
  const [invRole, setInvRole] = useState<"owner" | "manager" | "member">("member");
  const [invCap, setInvCap] = useState("");
  // per-row edit
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [manage, setManage] = useState<string | null>(null);
  const [bindWallet, setBindWallet] = useState("");
  const [confirmRm, setConfirmRm] = useState<string | null>(null);
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
        (await authFetch(`/api/team/orgs/${orgId}/members`)).json() as Promise<{ members?: Member[]; defaultAllowanceCredits?: number | null }>,
        (await authFetch(`/api/team/orgs/${orgId}/requests`)).json() as Promise<{ data?: IncreaseRequest[] }>,
      ]);
      setMembers(m.members ?? []);
      setRequests(r.data ?? []);
      setDefCap(m.defaultAllowanceCredits ?? null);
    } catch {
      setMembers([]);
      setRequests([]);
    }
  }, [orgId, mock, authFetch]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const sameWallet = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const isOwner = !!members?.some((m) => m.role === "owner" && (m.did === me?.did || sameWallet(m.walletAddress, me?.wallet)));
  const myMembership = members?.find((m) => m.did === me?.did || sameWallet(m.walletAddress, me?.wallet)) ?? null;
  // Pending email invite for my login address (matched client-side from the
  // Privy session; the server still requires my wallet signature to claim).
  const myInvite = !myMembership && me?.email ? members?.find((m) => m.status === "invited" && m.email?.toLowerCase() === me.email!.toLowerCase()) ?? null : null;
  // Managers share invite / cap / inbox powers; removal, defaults, and roles stay owner-only.
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
      const r = await authFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(d, r.status));
      await load();
      return d as Record<string, unknown>;
    } catch (e) {
      setErr(errorText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }

  function flashSaved(id: string) {
    setSaved(id);
    setTimeout(() => setSaved((s) => (s === id ? null : s)), 1800);
  }

  async function invite() {
    if (!invEmail.trim() || !myWallet) return;
    // Email-only (no wallet yet): server creates an "invited" row the invitee
    // claims on first login. With a wallet: immediate active member (wallet did).
    const emailOnly = !invWallet.trim();
    const did = emailOnly ? "" : `wallet:${invWallet.trim().toLowerCase()}`;
    const role = (members?.length ?? 0) === 0 ? "owner" : invRole; // first member founds as owner
    const expires = expiry();
    const action = emailOnly ? "member-invite" : "member-add";
    const fields: Record<string, string> = emailOnly
      ? { orgId, email: invEmail.trim().toLowerCase(), role }
      : { orgId, did, wallet: invWallet.trim(), role };
    const message = memberActionMessage(action, fields, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e) {
      setErr(`signing rejected: ${errorText(e)}`);
      return;
    }
    const cap = invCap.trim() ? Number(invCap) : undefined;
    const d = await post(
      `/api/team/orgs/${orgId}/members`,
      {
        member: emailOnly
          ? { email: invEmail.trim(), role, allowanceCredits: cap }
          : { did, walletAddress: invWallet.trim(), email: invEmail.trim() || null, role, allowanceCredits: cap },
        signature,
        message,
        signerWallet: myWallet,
      },
      "invite",
    );
    if (d) {
      setInvEmail("");
      setInvWallet("");
      setInvCap("");
      flashSaved("invite");
    }
  }

  // Claim my own email invite: I prove wallet ownership; the server matches the
  // email and activates me. My login email comes from the Privy session.
  async function claimInvite(email: string) {
    if (!me?.wallet || !me?.did) return;
    const expires = expiry();
    const message = inviteClaimMessage(orgId, email, me.did, me.wallet, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e) {
      setErr(`signing rejected: ${errorText(e)}`);
      return;
    }
    await post(`/api/team/orgs/${orgId}/members/claim`, { email, did: me.did, walletAddress: me.wallet, signature, message }, "claim");
  }

  async function patchMember(did: string, body: Record<string, unknown>, tag: string) {
    if (!myWallet) return false;
    const expires = expiry();
    const message = memberActionMessage("member-set", { orgId, did, ...(body.walletAddress ? { wallet: String(body.walletAddress).toLowerCase() } : {}) }, expires);
    let signature: string;
    setBusy(tag);
    try {
      signature = await sign(message);
    } catch (e) {
      setErr(`signing rejected: ${errorText(e)}`);
      setBusy(null);
      return false;
    }
    try {
      const r = await authFetch(`/api/team/orgs/${orgId}/members/${encodeURIComponent(did)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, signature, message, signerWallet: myWallet }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(d, r.status));
      await load();
      return true;
    } catch (e) {
      setErr(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  // The cap field commits on blur or Enter — the wallet signature is what makes it stick.
  async function commitCap(m: Member) {
    const raw = caps[m.did];
    if (raw === undefined) return;
    const next = raw.trim() === "" ? null : Number(raw.replace(/[^0-9.]/g, ""));
    if (next !== null && !Number.isFinite(next)) {
      setErr("enter a number, or leave it empty for the team default");
      return;
    }
    if (next === m.allowanceCredits) return;
    if (await patchMember(m.did, { allowanceCredits: next }, `cap-${m.did}`)) {
      setCaps((c) => {
        const rest = { ...c };
        delete rest[m.did];
        return rest;
      });
      flashSaved(m.did);
    }
  }

  async function remove(did: string) {
    if (!myWallet) return;
    const expires = expiry();
    const message = memberActionMessage("member-remove", { orgId, did }, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e) {
      setErr(`signing rejected: ${errorText(e)}`);
      return;
    }
    setBusy(`rm-${did}`);
    try {
      const r = await authFetch(`/api/team/orgs/${orgId}/members/${encodeURIComponent(did)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature, message, signerWallet: myWallet }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(d, r.status));
      setConfirmRm(null);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function requestIncrease() {
    if (!myMembership?.walletAddress || !reqAmount.trim()) return;
    const amountCredits = Number(reqAmount);
    const expires = expiry();
    // Must match the route's binding exactly: action + memberDid + amountCredits.
    const message = memberActionMessage("increase-request", { orgId, memberDid: myMembership.did, amountCredits: String(amountCredits) }, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e) {
      setErr(`signing rejected: ${errorText(e)}`);
      return;
    }
    const d = await post(
      `/api/team/orgs/${orgId}/requests`,
      { memberDid: myMembership.did, amountCredits, signature, message, signerWallet: myMembership.walletAddress },
      "request",
    );
    if (d) setReqAmount("");
  }

  async function decide(req: IncreaseRequest, decision: "approve" | "deny") {
    if (!myWallet) return;
    const expires = expiry();
    const message = approvalMessage({ id: req.id, orgId, memberDid: req.memberDid, amountCredits: req.amountCredits }, decision, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e) {
      setErr(`signing rejected: ${errorText(e)}`);
      return;
    }
    await post(`/api/team/orgs/${orgId}/requests/${req.id}`, { decision, signerWallet: myWallet, signature, message }, `decide-${req.id}`);
  }

  async function saveDefault() {
    if (!myWallet || !newDefault.trim()) return;
    const expires = expiry();
    const message = memberActionMessage("org-set-default", { orgId, default: String(Number(newDefault)) }, expires);
    let signature: string;
    try {
      signature = await sign(message);
    } catch (e) {
      setErr(`signing rejected: ${errorText(e)}`);
      return;
    }
    const d = await post(`/api/team/orgs/${orgId}/members`, { setDefault: Number(newDefault), signature, message, signerWallet: myWallet }, "default");
    if (d) {
      setNewDefault("");
      flashSaved("default");
    }
  }

  const rows = members ?? [];
  const pending = (requests ?? []).filter((r) => r.status === "pending");
  const allocated = rows.reduce((a, m) => a + (m.allowanceCredits ?? 0), 0);
  const inviteReady = invEmail.includes("@") && !!myWallet;

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[19px] font-medium tracking-[-0.02em]">Seats and allowances</h2>
          <span className="text-[13px] text-[#5D5D5D]">A cap commits when you leave the field — your wallet signs it, then the server applies it.</span>
        </div>
        <span className="font-mono text-[12px] tabular-nums text-[#5D5D5D]">
          {fmt(allocated)} credits allocated across {rows.length} seat{rows.length === 1 ? "" : "s"}
          {defCap !== null && ` · default ${fmt(defCap)}`}
        </span>
      </div>

      <div className="overflow-x-auto rounded-[14px] border border-[#E5E5E0]">
        <div className="grid min-w-[780px] grid-cols-[minmax(190px,1.6fr)_82px_minmax(132px,1.2fr)_132px_104px] gap-3.5 border-b border-[#E5E5E0] px-5 py-3 text-[10px] font-medium uppercase tracking-[0.08em] text-[#5D5D5D]">
          <span>member</span>
          <span>role</span>
          <span>spend this month</span>
          <span className="text-right">monthly cap</span>
          <span />
        </div>

        {rows.map((m) => {
          const didLabel = m.did.startsWith("wallet:") ? m.did.slice("wallet:".length) : m.did.replace(/^did:privy:/, "");
          const initials = (m.email ?? didLabel).slice(0, 2).toUpperCase();
          const invited = m.status === "invited";
          const bar = spendBarState(m.spentCredits, m.effectiveCredits);
          const capValue = caps[m.did] ?? (m.allowanceCredits === null ? "" : String(m.allowanceCredits));
          const open = manage === m.did;
          return (
            <div key={m.did} className="border-b border-[#F4F4F4] last:border-b-0">
              <div className="grid min-w-[780px] grid-cols-[minmax(190px,1.6fr)_82px_minmax(132px,1.2fr)_132px_104px] items-center gap-3.5 px-5 py-4 transition-colors hover:bg-[#FBFBFA]">
                <div className="flex min-w-0 items-center gap-[11px]">
                  <span className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${m.role === "owner" ? "bg-[#0D0D0D] text-white" : "bg-[#F4F4F4] text-[#424242]"}`}>
                    {initials}
                  </span>
                  <div className="flex min-w-0 flex-col gap-px">
                    <span className="truncate text-sm">{m.email ?? shortId(didLabel, 18)}</span>
                    <span className="truncate font-mono text-[11px] text-[#5D5D5D]">{invited ? "invited — no wallet yet" : shortId(m.did, 26)}</span>
                  </div>
                </div>

                <span className={`inline-flex h-[22px] items-center justify-self-start rounded-full px-2.5 text-[11px] ${ROLE_STYLE[m.role]}`} title={ROLE_HELP[m.role]}>
                  {m.role}
                </span>

                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2.5">
                    <span className={`whitespace-nowrap font-mono text-[13px] tabular-nums ${bar.state === "capped" ? "text-[#B3261E]" : ""}`}>
                      {m.spentCredits === null ? "—" : `${fmt(m.spentCredits)}${m.effectiveCredits === null ? " cr" : ` / ${fmt(m.effectiveCredits)}`}`}
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-[#5D5D5D]">{m.effectiveCredits === null ? "no cap" : bar.label}</span>
                  </div>
                  <span className="h-[5px] overflow-hidden rounded-full bg-[#F0F0EE]">
                    <span
                      className={`block h-full rounded-full ${
                        m.effectiveCredits === null ? "bg-[#CDCDCD]" : bar.state === "capped" ? "bg-[#DC2626]" : bar.state === "warning" ? "bg-[#D97706]" : "bg-[#0D0D0D]"
                      }`}
                      style={{ width: m.effectiveCredits === null ? "100%" : `${bar.pct}%` }}
                    />
                  </span>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <input
                    value={capValue}
                    onChange={(e) => setCaps((c) => ({ ...c, [m.did]: e.target.value }))}
                    onBlur={() => void commitCap(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    disabled={!canManage || mock || invited}
                    aria-label={`Monthly cap for ${m.email ?? didLabel}`}
                    placeholder={defCap === null ? "unlimited" : String(defCap)}
                    className={`${cell} ${bar.state === "capped" ? "border-[#F2C4C0]" : "border-[#E5E5E0]"} disabled:bg-[#FBFBFA] disabled:text-[#8F8F8F]`}
                  />
                  {busy === `cap-${m.did}` ? (
                    <span className="w-[15px] shrink-0 font-mono text-[11px] text-[#5D5D5D]">…</span>
                  ) : saved === m.did ? (
                    <span className="shrink-0 text-[#10A37F]" aria-label="Saved">
                      <Glyph d={SAVED} />
                    </span>
                  ) : (
                    <span className="w-[15px] shrink-0" />
                  )}
                </div>

                <div className="flex items-center justify-end gap-1.5">
                  <button onClick={() => setManage(open ? null : m.did)} className={small} aria-expanded={open}>
                    {open ? "Close" : "Manage"}
                  </button>
                </div>
              </div>

              {open && (
                <div className="flex min-w-[780px] flex-wrap items-center gap-x-4 gap-y-2 bg-[#FBFBFA] px-5 py-3.5">
                  <span className="break-all font-mono text-[11px] text-[#5D5D5D]">{m.did}</span>
                  {m.keyPrefix ? (
                    <span className="font-mono text-[11px] text-[#5D5D5D]">key {shortId(m.keyPrefix, 8)}</span>
                  ) : (
                    <span className="font-mono text-[11px] text-[#B3261E]">no key, headless only</span>
                  )}
                  {m.walletAddress && <span className="font-mono text-[11px] text-[#5D5D5D]">{shortId(m.walletAddress, 12)}</span>}

                  {invited && isOwner && !mock && (
                    <span className="flex items-center gap-2">
                      <input
                        value={bindWallet}
                        onChange={(e) => setBindWallet(e.target.value)}
                        placeholder="bind wallet 0x…"
                        spellCheck={false}
                        className="h-8 w-56 rounded-[10px] border border-[#E5E5E0] bg-white px-2.5 font-mono text-[12px] outline-none focus:border-black/40"
                      />
                      <button
                        onClick={async () => {
                          if (!/^0x[0-9a-fA-F]{40}$/.test(bindWallet.trim())) {
                            setErr("wallet must be 0x + 40 hex");
                            return;
                          }
                          if (await patchMember(m.did, { walletAddress: bindWallet.trim() }, `bind-${m.did}`)) setBindWallet("");
                        }}
                        disabled={busy === `bind-${m.did}`}
                        className={small}
                      >
                        {busy === `bind-${m.did}` ? "signing…" : "Bind"}
                      </button>
                    </span>
                  )}

                  {isOwner && !mock && (
                    <span className="ml-auto flex items-center gap-2">
                      {confirmRm === m.did ? (
                        <>
                          <span className="text-[11px] text-[#B3261E]">Remove {shortId(didLabel, 14)}? their spend stops at once.</span>
                          <button onClick={() => remove(m.did)} disabled={busy === `rm-${m.did}`} className="h-7 shrink-0 rounded-full bg-[#B3261E] px-3 text-[12px] text-white disabled:opacity-40">
                            {busy === `rm-${m.did}` ? "signing…" : invited ? "Confirm rescind" : "Confirm remove"}
                          </button>
                          <button onClick={() => setConfirmRm(null)} className="text-[11px] text-[#5D5D5D] underline">
                            keep
                          </button>
                        </>
                      ) : (
                        <button onClick={() => setConfirmRm(m.did)} className="text-[12px] text-[#B3261E] underline underline-offset-2">
                          {invited ? "Rescind invite" : "Remove from team"}
                        </button>
                      )}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {rows.length === 0 && <p className="m-0 px-5 py-6 text-sm text-[#8F8F8F]">No seats yet — invite the first below.</p>}

        {canInvite && !mock && (
          <div className="flex min-w-[780px] flex-wrap items-center gap-2.5 bg-[#FBFBFA] px-5 py-4">
            <input
              value={invEmail}
              onChange={(e) => setInvEmail(e.target.value)}
              placeholder="colleague@company.com"
              aria-label="Invite by email"
              autoComplete="email"
              className="h-[38px] min-w-[200px] flex-1 rounded-[10px] border border-[#E5E5E0] bg-white px-3.5 text-sm outline-none focus:border-black/40"
            />
            <div className="inline-flex rounded-full bg-[#F0F0EE] p-[3px]">
              {(["member", "manager", "owner"] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setInvRole(r)}
                  title={ROLE_HELP[r]}
                  className={`h-[30px] rounded-full px-3.5 text-[13px] font-medium capitalize transition-colors ${invRole === r ? "bg-white text-[#0D0D0D]" : "text-[#5D5D5D] hover:text-[#0D0D0D]"}`}
                >
                  {r}
                </button>
              ))}
            </div>
            <span className="flex items-center rounded-[10px] border border-[#E5E5E0] bg-white">
              <input
                value={invCap}
                onChange={(e) => setInvCap(e.target.value)}
                placeholder={defCap === null ? "default" : String(defCap)}
                aria-label="Monthly cap for the new seat"
                inputMode="numeric"
                className="h-[38px] w-[88px] rounded-[10px] bg-transparent px-2.5 text-right font-mono text-[13px] tabular-nums outline-none"
              />
              <span className="shrink-0 whitespace-nowrap pl-1 pr-2.5 text-[12px] text-[#5D5D5D]">cr/mo</span>
            </span>
            <input
              value={invWallet}
              onChange={(e) => setInvWallet(e.target.value)}
              placeholder="wallet 0x… (optional, adds them now)"
              spellCheck={false}
              className="h-[38px] min-w-[180px] flex-1 rounded-[10px] border border-[#E5E5E0] bg-white px-3 font-mono text-[12px] outline-none focus:border-black/40"
            />
            <button
              onClick={invite}
              disabled={busy === "invite" || !inviteReady}
              className="flex h-[38px] shrink-0 items-center rounded-full bg-[#0D0D0D] px-[18px] text-sm font-medium text-white transition-colors hover:bg-[#2F2F2F] disabled:border disabled:border-[#E5E5E0] disabled:bg-white disabled:text-[#8F8F8F]"
            >
              {busy === "invite" ? "signing…" : saved === "invite" ? "Invite sent" : (members?.length ?? 0) === 0 ? "Add founding owner" : "Invite"}
            </button>
            {!myWallet && <span className="text-[11px] text-[#B3261E]">connect your wallet to sign invites</span>}
          </div>
        )}
      </div>

      <span className="text-[12px] text-[#5D5D5D]">
        Invited seats get a Privy wallet on first login. Until then they hold no credits and can&apos;t route a call.
      </span>

      {myInvite && !mock && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#E5E5E0] bg-white p-3.5">
          <span className="text-[13px]">
            You&apos;re invited as <span className="font-medium">{myInvite.email}</span> ({myInvite.role}, {myInvite.allowanceCredits ?? defCap ?? "default"} credits).
          </span>
          <button onClick={() => claimInvite(myInvite.email!)} disabled={busy === "claim" || !me?.wallet} className={small}>
            {busy === "claim" ? "signing…" : "Accept invite"}
          </button>
          {!me?.wallet && <span className="text-[11px] text-[#B3261E]">connect your wallet to accept</span>}
        </div>
      )}

      {myMembership && myMembership.role !== "owner" && !mock && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-[#E5E5E0] p-3.5">
          <span className="text-[13px] text-[#5D5D5D]">Need headroom?</span>
          <span className="flex items-center rounded-[10px] border border-[#E5E5E0] bg-white">
            <input
              value={reqAmount}
              onChange={(e) => setReqAmount(e.target.value)}
              placeholder="new cap"
              inputMode="numeric"
              aria-label="Requested monthly cap"
              className="h-8 w-24 rounded-[10px] bg-transparent px-2.5 text-right font-mono text-[12px] tabular-nums outline-none"
            />
            <span className="shrink-0 pl-1 pr-2.5 text-[11px] text-[#5D5D5D]">cr/mo</span>
          </span>
          <button onClick={requestIncrease} disabled={busy === "request" || !reqAmount.trim()} className={small}>
            {busy === "request" ? "signing…" : "Request increase"}
          </button>
          <span className="font-mono text-[11px] text-[#8F8F8F]">you sign, an owner approves</span>
        </div>
      )}

      {pending.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Seat increase requests ({pending.length})</span>
          {pending.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#F2E1C4] bg-[#FDF3E2] px-4 py-3">
              <span className="font-mono text-[12px]">{shortId(r.memberDid.replace(/^did:privy:/, ""), 16)}</span>
              <span className="font-mono text-[13px] font-medium tabular-nums">→ {fmt(r.amountCredits)} credits/month</span>
              <span className="font-mono text-[11px] text-[#8A5300]">{ago(r.createdAt)}</span>
              {canManage && !mock && (
                <span className="ml-auto flex gap-2">
                  <button onClick={() => decide(r, "approve")} disabled={busy === `decide-${r.id}`} className="h-8 shrink-0 rounded-full bg-[#0D0D0D] px-4 text-[13px] text-white disabled:opacity-40">
                    {busy === `decide-${r.id}` ? "signing…" : "Approve"}
                  </button>
                  <button onClick={() => decide(r, "deny")} disabled={busy === `decide-${r.id}`} className="h-8 shrink-0 rounded-full border border-[#E5E5E0] bg-white px-4 text-[13px] text-[#B3261E] disabled:opacity-40">
                    Deny
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {isOwner && !mock && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-[#5D5D5D]">default cap for new seats</span>
          <span className="flex items-center rounded-[10px] border border-[#E5E5E0] bg-white">
            <input
              value={newDefault}
              onChange={(e) => setNewDefault(e.target.value)}
              placeholder={defCap === null ? "unlimited" : String(defCap)}
              inputMode="numeric"
              aria-label="Default cap for new seats"
              className="h-8 w-24 rounded-[10px] bg-transparent px-2.5 text-right font-mono text-[12px] tabular-nums outline-none"
            />
            <span className="shrink-0 pl-1 pr-2.5 text-[11px] text-[#5D5D5D]">cr/mo</span>
          </span>
          <button onClick={saveDefault} disabled={busy === "default" || !newDefault.trim()} className={small}>
            {busy === "default" ? "signing…" : "Set default"}
          </button>
          {saved === "default" && (
            <span className="text-[#10A37F]">
              <Glyph d={SAVED} />
            </span>
          )}
        </div>
      )}

      {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
    </section>
  );
}
