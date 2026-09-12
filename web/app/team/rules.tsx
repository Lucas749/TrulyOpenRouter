"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSignMessage } from "@privy-io/react-auth";
import { useAuthFetch } from "../components/use-auth-fetch";
import { memberActionMessage, ruleDecisionMessage, ruleSetMessage, stableJson } from "../../lib/member-messages";

// Firm rules: the limits that bind every seat, key and agent in the org. A call
// that breaks one is refused when the payment is authorised, before a host is
// paid. Owners set directly (one signature, applied and synced immediately);
// managers propose into the inbox below for an owner to approve.

interface Rules {
  orgId: string;
  dailyCapCredits?: number;
  allowedModels?: string[] | null;
  allowedRegions?: string[] | null;
  requireVerified?: boolean;
  agentExceptions?: boolean;
  rateLimitPerMin?: number;
  pinnedHosts?: string[] | null;
  perTxCapUsd?: number;
  updatedAt: number;
}

interface RuleChange {
  id: string;
  orgId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  createdByDid: string;
  decisionSigner?: string;
}

interface HostRow {
  address: string;
  modelId: string;
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
// Module scope on purpose: the signed messages carry a clock reading, which must not be
// read from component render code.
const expiry = (): number => Date.now() + 300_000;

const Glyph = ({ d, size = 17 }: { d: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const SHIELD = (
  <>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </>
);
const CEILING = (
  <>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <circle cx="12" cy="12" r="2" />
    <path d="M6 12h.01M18 12h.01" />
  </>
);
const PULSE = <path d="M22 12h-2.5l-2 7-4-16-3 9H2" />;
const CHIP = <path d="M4 4h16v16H4zM9 9h6v6H9zM15 2v2M9 2v2M15 20v2M9 20v2M20 15h2M20 9h2M2 15h2M2 9h2" />;
const GLOBE = (
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20" />
  </>
);
const HOSTS = (
  <>
    <rect x="2" y="3" width="20" height="8" rx="2" />
    <rect x="2" y="13" width="20" height="8" rx="2" />
    <path d="M6 7h.01M6 17h.01" />
  </>
);
const ASK = (
  <>
    <path d="M18 11V6a2 2 0 0 0-4 0v5" />
    <path d="M14 10V4a2 2 0 0 0-4 0v6" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v10" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8" />
  </>
);
const COIN = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M9.5 9.5h5M9.5 14.5h5" />
  </>
);
const SAVED = (
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </>
);

/// @notice Module scope: a component created during render would remount on every keystroke.
const SavedMark = ({ show }: { show: boolean }) =>
  show ? (
    <span className="inline-flex items-center gap-1 text-[12px] text-[#0B7A5D]">
      <Glyph size={14} d={SAVED} />
      saved
    </span>
  ) : null;

const setBtn =
  "flex h-9 shrink-0 items-center rounded-full bg-[#0D0D0D] px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#2F2F2F] disabled:bg-[#D4D4CF]";
const numberBox = "h-[38px] w-[104px] rounded-[10px] bg-transparent px-2.5 text-right font-mono text-sm tabular-nums text-[#0D0D0D] outline-none";
const chip = "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 font-mono text-[12px] transition-colors";

function Card({ icon, title, note, children }: { icon: ReactNode; title: string; note: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3.5 rounded-[14px] border border-[#E5E5E0] p-5">
      <div className="flex items-start gap-2.5">
        <span className="mt-px shrink-0 text-[#0D0D0D]">
          <Glyph d={icon} />
        </span>
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-medium">{title}</span>
          <span className="text-[12px] leading-[1.55] text-[#5D5D5D]">{note}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

export default function OrgRules({
  orgId,
  me,
  mock,
}: {
  orgId: string;
  me: { did: string; wallet: string | null } | null;
  mock: boolean;
}) {
  const { signMessage } = useSignMessage();
  const authFetch = useAuthFetch();
  const [rules, setRules] = useState<Rules | null>(null);
  const [pending, setPending] = useState<RuleChange[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [hosts, setHosts] = useState<HostRow[]>([]);

  const [daily, setDaily] = useState("");
  const [rate, setRate] = useState("");
  const [perTx, setPerTx] = useState("");

  // Hoisted so the memo depends on plain locals, not on a prop object the page rebuilds every render.
  const myDid = me?.did;
  const myWallet = me?.wallet;

  const load = useCallback(async () => {
    if (mock) {
      setIsOwner(true);
      setCanManage(true);
      setRules({ orgId, dailyCapCredits: 300, allowedModels: null, updatedAt: Date.now() });
      setPending([]);
      return;
    }
    try {
      const d = (await (await authFetch(`/api/team/orgs/${orgId}/rules`)).json()) as { rules?: Rules; changes?: RuleChange[] };
      setRules(d.rules ?? null);
      setPending((d.changes ?? []).filter((r) => r.status === "pending"));
      setDaily(d.rules?.dailyCapCredits == null ? "" : String(d.rules.dailyCapCredits));
      setRate(d.rules?.rateLimitPerMin == null ? "" : String(d.rules.rateLimitPerMin));
      setPerTx(d.rules?.perTxCapUsd == null ? "" : String(d.rules.perTxCapUsd));
    } catch {
      setRules(null);
    }
    try {
      const g = (await (await fetch(`/api/gw/v1/models`)).json()) as { data?: { id: string }[] };
      setModels((g.data ?? []).map((x) => x.id).filter(Boolean));
    } catch {}
    try {
      const h = (await (await fetch(`/api/gw/api/hosts`)).json()) as { data?: { address?: string; modelId?: string; geo?: string; region?: string }[] };
      const seen = new Set<string>();
      const hl: HostRow[] = [];
      for (const x of h.data ?? []) {
        if (x.geo) seen.add(x.geo);
        if (x.region) seen.add(x.region);
        if (x.address) hl.push({ address: x.address, modelId: x.modelId ?? "?" });
      }
      setRegions([...seen].sort());
      setHosts(hl);
    } catch {}
    try {
      const m = (await (await authFetch(`/api/team/orgs/${orgId}/members`)).json()) as {
        members?: { did: string; walletAddress: string | null; role: string }[];
      };
      const mine = (m.members ?? []).find((x) => x.did === myDid || (x.walletAddress && myWallet && x.walletAddress.toLowerCase() === myWallet.toLowerCase()));
      setIsOwner(mine?.role === "owner");
      setCanManage(mine?.role === "owner" || mine?.role === "manager");
    } catch {}
  }, [orgId, mock, myDid, myWallet, authFetch]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function sign(msg: string): Promise<string> {
    const r = await signMessage({ message: msg });
    return r.signature;
  }

  // Owners set directly; managers propose into the inbox. Same form, one branch.
  async function submit(kind: string, payload: Record<string, unknown>, tag: string) {
    if (!me?.wallet) return;
    // "1,000" or "$5" would become null (no limit) once serialized, so stop before signing.
    if (Object.values(payload).some((v) => typeof v === "number" && !Number.isFinite(v))) {
      setErr("enter a number, or leave it empty");
      return;
    }
    setBusy(tag);
    setErr(null);
    setNote(null);
    try {
      const expires = expiry();
      if (isOwner && !mock) {
        const message = ruleSetMessage(orgId, kind, payload, expires);
        const signature = await sign(message);
        const r = await authFetch(`/api/team/orgs/${orgId}/rules/set`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, payload, memberDid: me.did, signature, message, signerWallet: me.wallet }),
        });
        const d = (await r.json().catch(() => ({}))) as { error?: string; gatewaySynced?: boolean; gatewayError?: string };
        if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : String(r.status));
        setNote(d.gatewaySynced ? "enforced live on the gateway" : `saved locally${d.gatewayError ? ` (gateway sync failed: ${d.gatewayError})` : ""}`);
      } else {
        const message = memberActionMessage("rule-propose", { orgId, kind, payload: stableJson(payload) }, expires);
        const signature = await sign(message);
        const r = await authFetch(`/api/team/orgs/${orgId}/rules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, payload, memberDid: me.did, signature, message, signerWallet: me.wallet }),
        });
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : String(r.status));
        setNote("proposed — waiting in the inbox below for an owner");
      }
      setSaved(tag);
      setTimeout(() => setSaved((s) => (s === tag ? null : s)), 1800);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function decide(req: RuleChange, decision: "approve" | "deny") {
    if (!me?.wallet) return;
    setBusy(`decide-${req.id}`);
    setErr(null);
    setNote(null);
    try {
      const message = ruleDecisionMessage({ id: req.id, orgId, kind: req.kind, payloadJson: stableJson(req.payload) }, decision, expiry());
      const signature = await sign(message);
      const r = await authFetch(`/api/team/orgs/${orgId}/rules/changes/${req.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, signerWallet: me.wallet, signature, message }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; gatewaySynced?: boolean; gatewayError?: string };
      if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : String(r.status));
      setNote(d.gatewaySynced ? "approved — enforced live on the gateway" : `approved${d.gatewayError ? ` (gateway sync failed: ${d.gatewayError})` : ""}`);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const currentModels = rules?.allowedModels ?? null;
  const currentRegions = rules?.allowedRegions ?? null;
  const currentHosts = rules?.pinnedHosts ?? null;
  const verb = isOwner ? "Set" : "Propose";
  const locked = !canManage || mock || !me?.wallet;

  // A chip commits immediately: toggling rewrites the whole list, which is what the server stores.
  const toggleList = (kind: string, key: string, current: string[] | null, all: string[], field: string) => {
    const base = current ?? [];
    const next = base.includes(key) ? base.filter((x) => x !== key) : [...base, key];
    void submit(kind, { [field]: next.length && next.length < all.length ? next : next.length ? next : null }, kind);
  };

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h2 className="m-0 text-[19px] font-medium tracking-[-0.02em]">Firm rules</h2>
            <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-[#E7F5EE] px-2.5 text-[11px] text-[#0B7A5D]">
              <Glyph size={12} d={SHIELD} />
              enforced at payment
            </span>
          </div>
          <span className="text-[13px] text-[#5D5D5D]">
            These bind every seat, key and agent in the org. A call that breaks one is refused when the payment is authorised, not logged after the fact.
          </span>
        </div>
        {rules && (
          <span className="font-mono text-[12px] tabular-nums text-[#5D5D5D]">
            updated {new Date(rules.updatedAt).toISOString().slice(0, 10)}
            {!isOwner && canManage && " · you propose, an owner approves"}
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(288px,1fr))]">
        <Card icon={CEILING} title="Daily ceiling" note="Credits per UTC day across the whole org. Empty means no ceiling.">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="flex items-center rounded-[10px] border border-[#E5E5E0] bg-white">
              <input value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="unlimited" aria-label="Daily ceiling" inputMode="numeric" disabled={locked} className={numberBox} />
              <span className="shrink-0 whitespace-nowrap pl-1 pr-3 text-[12px] text-[#5D5D5D]">cr/day</span>
            </span>
            <button onClick={() => submit("daily_cap", { credits: daily.trim() === "" ? null : Number(daily) }, "daily_cap")} disabled={locked || busy === "daily_cap"} className={setBtn}>
              {busy === "daily_cap" ? "signing…" : verb}
            </button>
            <SavedMark show={saved === "daily_cap"} />
          </div>
        </Card>

        <Card icon={PULSE} title="Rate limit" note="Calls per minute across the org. This is what stops a runaway agent.">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="flex items-center rounded-[10px] border border-[#E5E5E0] bg-white">
              <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="unlimited" aria-label="Rate limit" inputMode="numeric" disabled={locked} className={numberBox} />
              <span className="shrink-0 whitespace-nowrap pl-1 pr-3 text-[12px] text-[#5D5D5D]">req/min</span>
            </span>
            <button onClick={() => submit("rate_limit", { perMin: rate.trim() === "" ? null : Number(rate) }, "rate_limit")} disabled={locked || busy === "rate_limit"} className={setBtn}>
              {busy === "rate_limit" ? "signing…" : verb}
            </button>
            <SavedMark show={saved === "rate_limit"} />
          </div>
        </Card>

        <Card
          icon={CHIP}
          title="Allowed models"
          note={currentModels == null ? "Nothing selected — every registered model is routable." : `${currentModels.length} of ${models.length} models routable. Anything else is refused at payment.`}
        >
          <div className="flex flex-wrap gap-2">
            {models.length === 0 && <span className="font-mono text-[11px] text-[#8F8F8F]">loading…</span>}
            {models.map((m) => {
              const on = currentModels?.includes(m) ?? false;
              return (
                <button
                  key={m}
                  aria-pressed={on}
                  disabled={locked || !!busy}
                  onClick={() => toggleList("models", m, currentModels, models, "models")}
                  className={`${chip} ${on ? "border-[#0D0D0D] bg-[#0D0D0D] text-white" : "border-[#E5E5E0] bg-white text-[#424242] hover:bg-[#F4F4F4]"} disabled:opacity-50`}
                >
                  {on && <Glyph size={13} d={<path d="m5 12 5 5L20 7" />} />}
                  {m}
                </button>
              );
            })}
          </div>
          <SavedMark show={saved === "models"} />
        </Card>

        <Card
          icon={GLOBE}
          title="Allowed regions"
          note={currentRegions == null ? "Nothing selected — hosts in any region can serve." : `${currentRegions.length} regions allowed, by observed IP with self-report as fallback.`}
        >
          <div className="flex flex-wrap gap-2">
            {regions.length === 0 && (
              <span className="font-mono text-[11px] text-[#8F8F8F]">
                {hosts.length ? `${hosts.length} host${hosts.length === 1 ? "" : "s"} online, none report a location` : "no hosts online yet"}
              </span>
            )}
            {regions.map((r) => {
              const on = currentRegions?.includes(r) ?? false;
              return (
                <button
                  key={r}
                  aria-pressed={on}
                  disabled={locked || !!busy}
                  onClick={() => toggleList("regions", r, currentRegions, regions, "regions")}
                  className={`${chip} ${on ? "border-[#0D0D0D] bg-[#0D0D0D] text-white" : "border-[#E5E5E0] bg-white text-[#424242] hover:bg-[#F4F4F4]"} disabled:opacity-50`}
                >
                  {on && <Glyph size={13} d={<path d="m5 12 5 5L20 7" />} />}
                  {r}
                </button>
              );
            })}
          </div>
          <SavedMark show={saved === "regions"} />
        </Card>

        <div className="flex flex-col rounded-[14px] border border-[#E5E5E0] p-5 sm:col-span-full">
          <div className="flex items-center gap-4 border-b border-[#F4F4F4] py-3 first:pt-0">
            <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[#F4F4F4] text-[#0D0D0D]">
              <Glyph size={15} d={SHIELD} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm">Verified hosts only</span>
              <span className="text-[12px] leading-[1.55] text-[#5D5D5D]">Hosts that failed a spot-check are excluded even when healthy and cheap.</span>
            </div>
            <button
              role="switch"
              aria-checked={!!rules?.requireVerified}
              aria-label="Verified hosts only"
              disabled={locked || busy === "verified"}
              onClick={() => submit("verified", { only: !(rules?.requireVerified ?? false) }, "verified")}
              className={`relative ml-auto h-6 w-[42px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${rules?.requireVerified ? "bg-[#0D0D0D]" : "bg-[#CDCDCD]"}`}
            >
              <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${rules?.requireVerified ? "left-[21px]" : "left-[3px]"}`} />
            </button>
          </div>

          <div className="flex items-center gap-4 border-b border-[#F4F4F4] py-3">
            <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[#F4F4F4] text-[#0D0D0D]">
              <Glyph size={15} d={ASK} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm">Agents may ask for more</span>
              <span className="text-[12px] leading-[1.55] text-[#5D5D5D]">
                At its ceiling an agent gets an approval link instead of a refusal. Off means a hard stop for every agent in this team.
              </span>
            </div>
            <button
              role="switch"
              aria-checked={rules?.agentExceptions !== false}
              aria-label="Agents may ask for more"
              disabled={locked || busy === "agent_exceptions"}
              onClick={() => submit("agent_exceptions", { allowed: rules?.agentExceptions === false }, "agent_exceptions")}
              className={`relative ml-auto h-6 w-[42px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${rules?.agentExceptions !== false ? "bg-[#0D0D0D]" : "bg-[#CDCDCD]"}`}
            >
              <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${rules?.agentExceptions !== false ? "left-[21px]" : "left-[3px]"}`} />
            </button>
          </div>

          <div className="flex items-center gap-4 border-b border-[#F4F4F4] py-3">
            <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[#F4F4F4] text-[#0D0D0D]">
              <Glyph size={15} d={COIN} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm">Per-transaction cap</span>
              <span className="text-[12px] leading-[1.55] text-[#5D5D5D]">A ceiling per inference, in USD. Shown on agent keys and enforced by the wallet policy at creation.</span>
            </div>
            <span className="ml-auto flex items-center gap-2">
              <span className="flex items-center rounded-[10px] border border-[#E5E5E0] bg-white">
                <input value={perTx} onChange={(e) => setPerTx(e.target.value)} placeholder="none" aria-label="Per-transaction cap in USD" inputMode="decimal" disabled={locked} className={`${numberBox} w-[84px]`} />
                <span className="shrink-0 pl-1 pr-3 text-[12px] text-[#5D5D5D]">USD</span>
              </span>
              <button onClick={() => submit("per_tx_cap", { usd: perTx.trim() === "" ? null : Number(perTx) }, "per_tx_cap")} disabled={locked || busy === "per_tx_cap"} className={setBtn}>
                {busy === "per_tx_cap" ? "signing…" : verb}
              </button>
              <SavedMark show={saved === "per_tx_cap"} />
            </span>
          </div>

          <div className="flex items-center gap-4 py-3 pb-0">
            <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[#F4F4F4] text-[#0D0D0D]">
              <Glyph size={15} d={HOSTS} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm">Pinned hosts</span>
              <span className="text-[12px] leading-[1.55] text-[#5D5D5D]">
                {currentHosts == null ? "Any host on the network may serve this org." : `${currentHosts.length} host${currentHosts.length === 1 ? "" : "s"} pinned — nothing else is routable.`}
              </span>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {hosts.length === 0 && <span className="font-mono text-[11px] text-[#8F8F8F]">no hosts on the network yet</span>}
                {hosts.map((h) => {
                  const on = currentHosts?.includes(h.address) ?? false;
                  return (
                    <button
                      key={h.address}
                      aria-pressed={on}
                      disabled={locked || !!busy}
                      title={`${h.address} · ${h.modelId}`}
                      onClick={() => toggleList("hosts", h.address, currentHosts, hosts.map((x) => x.address), "hosts")}
                      className={`${chip} ${on ? "border-[#0D0D0D] bg-[#0D0D0D] text-white" : "border-[#E5E5E0] bg-white text-[#424242] hover:bg-[#F4F4F4]"} disabled:opacity-50`}
                    >
                      {on && <Glyph size={13} d={<path d="m5 12 5 5L20 7" />} />}
                      {h.address.slice(0, 10)}… · {h.modelId}
                    </button>
                  );
                })}
              </div>
            </div>
            <span className="ml-auto self-start">
              <SavedMark show={saved === "hosts"} />
            </span>
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Rule inbox ({pending.length})</span>
          {pending.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#F2E1C4] bg-[#FDF3E2] px-4 py-3">
              <span className="font-mono text-[12px]">
                {r.kind}: {stableJson(r.payload)}
              </span>
              {isOwner && !mock && (
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

      {!me?.wallet && canManage && <span className="text-[12px] text-[#B3261E]">Connect your wallet to change rules — every change is signed.</span>}
      {note && <p className="m-0 font-mono text-xs text-[#0B7A5D]">{note}</p>}
      {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
    </section>
  );
}
