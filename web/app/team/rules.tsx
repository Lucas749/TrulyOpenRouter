"use client";

import { useCallback, useEffect, useState } from "react";
import { useSignMessage } from "@privy-io/react-auth";
import { useAuthFetch } from "../components/use-auth-fetch";
import { memberActionMessage, ruleDecisionMessage, ruleSetMessage, stableJson } from "../../lib/member-messages";

// Firm rules, designed like the landing page: one row per rule, current value
// left, control + Set right. Owners set directly (one signature, applied +
// synced immediately). Managers propose (same form, goes to the inbox below
// for owner approval). Every option is an enum/number — nothing free-typed.

interface Rules {
  orgId: string;
  dailyCapCredits?: number;
  allowedModels?: string[] | null;
  allowedRegions?: string[] | null;
  requireVerified?: boolean;
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

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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
  const [history, setHistory] = useState<RuleChange[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [hosts, setHosts] = useState<{ address: string; modelId: string }[]>([]);

  const [open, setOpen] = useState(false);
  const [daily, setDaily] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedRegions, setPickedRegions] = useState<string[]>([]);
  const [pickedHosts, setPickedHosts] = useState<string[]>([]);
  const [rate, setRate] = useState("");
  const [perTx, setPerTx] = useState("");

  const load = useCallback(async () => {
    if (mock) {
      setIsOwner(true);
      setCanManage(true);
      setRules({ orgId, dailyCapCredits: 300, allowedModels: null, updatedAt: Date.now() });
      setPending([]);
      setHistory([]);
      return;
    }
    try {
      const d: any = await (await authFetch(`/api/team/orgs/${orgId}/rules`)).json();
      setRules(d.rules ?? null);
      const all: RuleChange[] = d.changes ?? [];
      setPending(all.filter((r) => r.status === "pending"));
      setHistory(all.filter((r) => r.status !== "pending").slice(0, 5));
    } catch {
      setRules(null);
    }
    try {
      const g: any = await (await fetch(`/api/gw/v1/models`)).json().catch(() => ({}));
      setModels(((g.data ?? []) as any[]).map((x) => x.id).filter(Boolean));
    } catch {}
    try {
      const h: any = await (await fetch(`/api/gw/api/hosts`)).json().catch(() => ({}));
      const seen = new Set<string>();
      const hl: { address: string; modelId: string }[] = [];
      for (const x of (h.data ?? []) as any[]) {
        if (x.geo) seen.add(x.geo);
        if (x.region) seen.add(x.region);
        if (x.address) hl.push({ address: x.address, modelId: x.modelId ?? "?" });
      }
      setRegions([...seen].sort());
      setHosts(hl);
    } catch {}
    try {
      const m: any = await (await authFetch(`/api/team/orgs/${orgId}/members`)).json();
      const mine = (m.members ?? []).find(
        (x: any) => x.did === me?.did || (x.walletAddress && me?.wallet && x.walletAddress.toLowerCase() === me.wallet.toLowerCase()),
      );
      setIsOwner(mine?.role === "owner");
      setCanManage(mine?.role === "owner" || mine?.role === "manager");
    } catch {}
  }, [orgId, mock, me?.did, me?.wallet, authFetch]);

  useEffect(() => {
    load();
  }, [load]);

  async function sign(msg: string): Promise<string> {
    const r = await signMessage({ message: msg });
    return r.signature;
  }

  // Owners set directly; managers propose into the inbox. Same form, one branch.
  async function submit(kind: string, payload: Record<string, unknown>, tag: string) {
    if (!me || !me.wallet) return;
    // "1,000" or "$5" would become null (no limit) once serialized, so stop before signing.
    if (Object.values(payload).some((v) => typeof v === "number" && !Number.isFinite(v))) {
      setErr("enter a number, or leave it empty");
      return;
    }
    setBusy(tag);
    setErr(null);
    setNote(null);
    try {
      const expires = Date.now() + 300_000;
      if (isOwner && !mock) {
        const message = ruleSetMessage(orgId, kind, payload, expires);
        const signature = await sign(message).catch((e: any) => {
          throw new Error(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
        });
        const r = await authFetch(`/api/team/orgs/${orgId}/rules/set`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, payload, memberDid: me.did, signature, message, signerWallet: me.wallet }),
        });
        const d: any = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : r.status);
        setNote(d.gatewaySynced ? "set ✓ enforced live on the gateway" : `set ✓ locally${d.gatewayError ? ` (gateway sync failed: ${d.gatewayError})` : ""}`);
      } else {
        const message = memberActionMessage("rule-propose", { orgId, kind, payload: stableJson(payload) }, expires);
        const signature = await sign(message).catch((e: any) => {
          throw new Error(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
        });
        const r = await authFetch(`/api/team/orgs/${orgId}/rules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, payload, memberDid: me.did, signature, message, signerWallet: me.wallet }),
        });
        const d: any = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : r.status);
        setNote("proposed ✓ waiting in the inbox below for an owner");
      }
      setDaily("");
      setPicked([]);
      setPickedRegions([]);
      setPickedHosts([]);
      setRate("");
      setPerTx("");
      await load();
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 200));
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
      const message = ruleDecisionMessage(
        { id: req.id, orgId, kind: req.kind, payloadJson: stableJson(req.payload) },
        decision,
        Date.now() + 300_000,
      );
      const signature = await sign(message).catch((e: any) => {
        throw new Error(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      });
      const r = await authFetch(`/api/team/orgs/${orgId}/rules/changes/${req.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, signerWallet: me.wallet, signature, message }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : r.status);
      setNote(d.gatewaySynced ? "approved ✓ enforced live on the gateway" : `approved ✓${d.gatewayError ? ` (gateway sync failed: ${d.gatewayError})` : ""}`);
      await load();
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 200));
    } finally {
      setBusy(null);
    }
  }

  const currentModels = rules?.allowedModels ?? null;
  const currentRegions = rules?.allowedRegions ?? null;
  const verb = isOwner ? "Set" : "Propose";

  const row = "flex flex-col gap-2 rounded-xl border border-[#E5E5E0] px-4 py-3 sm:flex-row sm:items-center";
  const label = "text-sm font-medium";
  const sub = "font-mono text-[11px] text-[#6E6E73]";
  const setBtn =
    "h-9 shrink-0 rounded-full bg-black px-5 text-sm text-white disabled:opacity-40";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#E5E5E0] px-4 py-3">
      <button onClick={() => setOpen((o) => !o)} className="flex flex-wrap items-baseline gap-x-3 text-left">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Firm rules</span>
        <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">
          {rules ? (
            <>
              daily {rules.dailyCapCredits == null ? "unlimited" : `${rules.dailyCapCredits} credits`} · models{" "}
              {currentModels == null ? "all" : currentModels.length ? currentModels.join(", ") : "none"} · regions{" "}
              {currentRegions == null ? "all" : currentRegions.length ? currentRegions.join(", ") : "none"}
              {rules.requireVerified ? " · verified only" : ""} · rate{" "}
              {rules.rateLimitPerMin == null ? "unlimited" : `${rules.rateLimitPerMin}/min`} · hosts{" "}
              {rules.pinnedHosts == null ? "any" : rules.pinnedHosts.length ? `${rules.pinnedHosts.length} pinned` : "none"}
            </>
          ) : (
            "…"
          )}
        </span>
        <span className={`font-mono text-xs text-[#8F8F8F] transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && (
        <>
      {canManage && !mock && (
        <>
          <div className={row}>
            <div className="min-w-0 flex-1">
              <div className={label}>Daily ceiling</div>
              <div className={sub}>credits per day across the org, resets UTC midnight (empty = unlimited)</div>
            </div>
            <input
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder={rules?.dailyCapCredits == null ? "unlimited" : String(rules.dailyCapCredits)}
              className="h-9 w-36 rounded-lg border border-black/10 px-3 font-mono text-sm"
              inputMode="numeric" autoComplete="off"
            />
            <button
              onClick={() => submit("daily_cap", { credits: daily.trim() === "" ? null : Number(daily) }, "daily")}
              disabled={busy === "daily" || !me?.wallet}
              className={setBtn}
            >
              {busy === "daily" ? "…" : verb}
            </button>
          </div>

          <div className={row}>
            <div className="min-w-0 flex-1">
              <div className={label}>Allowed models</div>
              <div className={sub}>unticked = all models allowed</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {models.length === 0 && <span className="font-mono text-[11px] text-[#8F8F8F]">loading…</span>}
                {models.map((m) => {
                  const on = picked.includes(m);
                  return (
                    <button
                      key={m}
                      onClick={() => setPicked((p) => (on ? p.filter((x) => x !== m) : [...p, m]))}
                      className={`rounded-full border px-3 py-1 font-mono text-[11px] ${on ? "border-black bg-black text-white" : "border-black/10 bg-white hover:bg-black/5"}`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              onClick={() => submit("models", { models: picked.length ? picked : null }, "models")}
              disabled={busy === "models" || !me?.wallet}
              className={setBtn}
            >
              {busy === "models" ? "…" : verb}
            </button>
          </div>

          <div className={row}>
            <div className="min-w-0 flex-1">
              <div className={label}>Allowed regions</div>
              <div className={sub}>unticked = all regions (observed IP geo, self-report fallback)</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {regions.length === 0 && (
                  <span className="font-mono text-[11px] text-[#8F8F8F]">
                    {hosts.length
                      ? `${hosts.length} host${hosts.length === 1 ? "" : "s"} online, none report a location — hosts set it with tor-host run --region <slug>`
                      : "no hosts online yet"}
                  </span>
                )}
                {regions.map((r) => {
                  const on = pickedRegions.includes(r);
                  return (
                    <button
                      key={r}
                      onClick={() => setPickedRegions((p) => (on ? p.filter((x) => x !== r) : [...p, r]))}
                      className={`rounded-full border px-3 py-1 font-mono text-[11px] ${on ? "border-black bg-black text-white" : "border-black/10 bg-white hover:bg-black/5"}`}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              onClick={() => submit("regions", { regions: pickedRegions.length ? pickedRegions : null }, "regions")}
              disabled={busy === "regions" || !me?.wallet || regions.length === 0}
              className={setBtn}
            >
              {busy === "regions" ? "…" : verb}
            </button>
          </div>

          <div className={row}>
            <div className="min-w-0 flex-1">
              <div className={label}>Verified hosts only</div>
              <div className={sub}>cheat hosts excluded even when healthy {rules?.requireVerified ? "(currently on)" : "(currently off)"}</div>
            </div>
            <button
              onClick={() => submit("verified", { only: !(rules?.requireVerified ?? false) }, "verified")}
              disabled={busy === "verified" || !me?.wallet}
              className={setBtn}
            >
              {busy === "verified" ? "…" : rules?.requireVerified ? "Allow all" : "Require verified"}
            </button>
          </div>

          <div className={row}>
            <div className="min-w-0 flex-1">
              <div className={label}>Rate limit</div>
              <div className={sub}>calls per minute across the org, stops runaway agents (empty = unlimited)</div>
            </div>
            <input
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder={rules?.rateLimitPerMin == null ? "unlimited" : String(rules.rateLimitPerMin)}
              className="h-9 w-36 rounded-lg border border-black/10 px-3 font-mono text-sm"
              inputMode="numeric" autoComplete="off"
            />
            <button
              onClick={() => submit("rate_limit", { perMin: rate.trim() === "" ? null : Number(rate) }, "rate")}
              disabled={busy === "rate" || !me?.wallet}
              className={setBtn}
            >
              {busy === "rate" ? "…" : verb}
            </button>
          </div>

          <div className={row}>
            <div className="min-w-0 flex-1">
              <div className={label}>Pinned hosts</div>
              <div className={sub}>unticked = any host; pin spend to hosts you trust</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {hosts.length === 0 && <span className="font-mono text-[11px] text-[#8F8F8F]">no hosts on the network yet</span>}
                {hosts.map((h) => {
                  const on = pickedHosts.includes(h.address);
                  return (
                    <button
                      key={h.address}
                      onClick={() => setPickedHosts((p) => (on ? p.filter((x) => x !== h.address) : [...p, h.address]))}
                      title={`${h.address} · ${h.modelId}`}
                      className={`rounded-full border px-3 py-1 font-mono text-[11px] ${on ? "border-black bg-black text-white" : "border-black/10 bg-white hover:bg-black/5"}`}
                    >
                      {h.address.slice(0, 10)}… · {h.modelId}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              onClick={() => submit("hosts", { hosts: pickedHosts.length ? pickedHosts : null }, "hosts")}
              disabled={busy === "hosts" || !me?.wallet}
              className={setBtn}
            >
              {busy === "hosts" ? "…" : verb}
            </button>
          </div>

          <div className={row}>
            <div className="min-w-0 flex-1">
              <div className={label}>Per-transaction display cap</div>
              <div className={sub}>a cap per LLM inference, in USD — display only, enforced by the wallet policy at creation (empty = none)</div>
            </div>
            <input
              value={perTx}
              onChange={(e) => setPerTx(e.target.value)}
              placeholder={rules?.perTxCapUsd == null ? "none" : String(rules.perTxCapUsd)}
              className="h-9 w-36 rounded-lg border border-black/10 px-3 font-mono text-sm"
              inputMode="numeric" autoComplete="off"
            />
            <button
              onClick={() => submit("per_tx_cap", { usd: perTx.trim() === "" ? null : Number(perTx) }, "pertx")}
              disabled={busy === "pertx" || !me?.wallet}
              className={setBtn}
            >
              {busy === "pertx" ? "…" : verb}
            </button>
          </div>
          {!me?.wallet && <span className="text-[11px] text-[#B3261E]">connect your wallet to change rules</span>}
        </>
      )}

      {pending.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Rule inbox ({pending.length})</span>
          {pending.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#FDF3E2] px-3 py-2">
              <span className="font-mono text-xs">
                {r.kind}: {stableJson(r.payload)}
              </span>
              {isOwner && !mock ? (
                <span className="ml-auto flex gap-2">
                  <button onClick={() => decide(r, "approve")} disabled={busy === `decide-${r.id}`} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">
                    {busy === `decide-${r.id}` ? "signing…" : "Approve"}
                  </button>
                  <button onClick={() => decide(r, "deny")} disabled={busy === `decide-${r.id}`} className="rounded-full border border-black/15 px-3 py-1 text-[11px] disabled:opacity-40">Deny</button>
                </span>
              ) : (
                <span className="ml-auto rounded-full bg-[#FDF3E2] px-2.5 py-0.5 text-[11px] text-[#8A5300]">pending owner</span>
              )}
            </div>
          ))}
        </div>
      )}
      {history.length > 0 && (
        <div className="flex flex-col gap-1">
          {history.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-[#6E6E73]">
              <span>{r.kind}</span>
              <span className={r.status === "approved" ? "text-[#0B7A5D]" : "text-[#B3261E]"}>{r.status}</span>
              {r.decisionSigner && <span>signed {r.decisionSigner.slice(0, 10)}…</span>}
            </div>
          ))}
        </div>
      )}
        </>
      )}
      {note && <p className="m-0 font-mono text-xs text-[#0B7A5D]">{note}</p>}
      {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
    </div>
  );
}
