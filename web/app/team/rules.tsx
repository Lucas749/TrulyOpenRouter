"use client";

import { useCallback, useEffect, useState } from "react";
import { useSignMessage } from "@privy-io/react-auth";
import { memberActionMessage, ruleDecisionMessage, stableJson } from "../../lib/member-messages";

// Firm rules per org: daily ceiling, model allowlist, per-tx display cap.
// Owners AND managers may propose; only owners decide. Approval applies
// locally and syncs to gateway pre-flight enforcement. Same wallet-signature
// discipline as members/inbox (canonical bytes, 5-min TTL).

interface Rules {
  orgId: string;
  dailyCapCredits?: number;
  allowedModels?: string[] | null;
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
  // Role gates need the member list; one extra read per org card (shared cache
  // would couple this to OrgMembers internals — correctness over cleverness).
  const [isOwner, setIsOwner] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const { signMessage } = useSignMessage();
  const [rules, setRules] = useState<Rules | null>(null);
  const [pending, setPending] = useState<RuleChange[]>([]);
  const [history, setHistory] = useState<RuleChange[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [daily, setDaily] = useState("");
  const [modelInput, setModelInput] = useState("");
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
      const g: any = await (await fetch(`/api/gw/v1/models`)).json().catch(() => ({}));
      setModels(((g.data ?? []) as any[]).map((x) => x.id).filter(Boolean));
    } catch {}
    try {
      const m: any = await (await fetch(`/api/team/orgs/${orgId}/members`)).json();
      const mine = (m.members ?? []).find(
        (x: any) => x.did === me?.did || (x.walletAddress && me?.wallet && x.walletAddress.toLowerCase() === me.wallet.toLowerCase()),
      );
      setIsOwner(mine?.role === "owner");
      setCanManage(mine?.role === "owner" || mine?.role === "manager");
    } catch {}
    try {
      const d: any = await (await fetch(`/api/team/orgs/${orgId}/rules`)).json();
      setRules(d.rules ?? null);
      const all: RuleChange[] = d.changes ?? [];
      setPending(all.filter((r) => r.status === "pending"));
      setHistory(all.filter((r) => r.status !== "pending").slice(0, 5));
    } catch {
      setRules(null);
    }
  }, [orgId, mock]);

  useEffect(() => {
    load();
  }, [load]);

  async function sign(msg: string): Promise<string> {
    const r = await signMessage({ message: msg });
    return r.signature;
  }

  async function propose(kind: string, payload: Record<string, unknown>, tag: string) {
    if (!me || !me.wallet) return;
    setBusy(tag);
    setErr(null);
    try {
      const message = memberActionMessage("rule-propose", { orgId, kind, payload: stableJson(payload) }, Date.now() + 300_000);
      const signature = await sign(message).catch((e: any) => {
        throw new Error(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      });
      const r = await fetch(`/api/team/orgs/${orgId}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, payload, memberDid: me.did, signature, message, signerWallet: me.wallet }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : r.status);
      setDaily("");
      setModelInput("");
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
    try {
      const message = ruleDecisionMessage(
        { id: req.id, orgId, kind: req.kind, payloadJson: stableJson(req.payload) },
        decision,
        Date.now() + 300_000,
      );
      const signature = await sign(message).catch((e: any) => {
        throw new Error(`signing rejected: ${String(e?.message ?? e).slice(0, 120)}`);
      });
      const r = await fetch(`/api/team/orgs/${orgId}/rules/changes/${req.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, signerWallet: me.wallet, signature, message }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d.error === "string" ? d.error : r.status);
      await load();
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 200));
    } finally {
      setBusy(null);
    }
  }

  const currentModels = rules?.allowedModels ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#E5E5E0] px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Firm rules</span>
        <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">
          {rules ? (
            <>
              daily {rules.dailyCapCredits == null ? "unlimited" : `${rules.dailyCapCredits} credits`} · models{" "}
              {currentModels == null ? "all" : currentModels.length ? currentModels.join(", ") : "none"}
              {rules.perTxCapUsd != null && <> · per-tx {usd(rules.perTxCapUsd)}</>}
            </>
          ) : (
            "…"
          )}
        </span>
      </div>

      {canManage && !mock && (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-black/15 p-3">
          <span className="text-xs font-medium">Propose a rule change (you sign, owner approves)</span>
          <div className="flex flex-wrap gap-2">
            <input
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              placeholder="daily ceiling, credits (empty = unlimited)"
              className="h-8 min-w-[220px] flex-1 rounded-lg border border-black/10 px-2.5 font-mono text-xs"
              inputMode="numeric"
            />
            <button
              onClick={() => propose("daily_cap", { credits: daily.trim() === "" ? null : Number(daily) }, "daily")}
              disabled={busy === "daily" || !me?.wallet}
              className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40"
            >
              {busy === "daily" ? "signing…" : "Propose"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              placeholder="allowed models, comma-separated (empty = all)"
              className="h-8 min-w-[220px] flex-1 rounded-lg border border-black/10 px-2.5 font-mono text-xs"
            />
            <button
              onClick={() => {
                const models = modelInput.trim() === "" ? null : modelInput.split(",").map((s) => s.trim()).filter(Boolean);
                propose("models", { models }, "models");
              }}
              disabled={busy === "models" || !me?.wallet}
              className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40"
            >
              {busy === "models" ? "signing…" : "Propose"}
            </button>
          </div>
          {models.length > 0 && <span className="font-mono text-[11px] text-[#8F8F8F]">on the network now: {models.join(", ")}</span>}
          <div className="flex flex-wrap gap-2">
            <input
              value={perTx}
              onChange={(e) => setPerTx(e.target.value)}
              placeholder="per-tx display cap, USD (empty = none)"
              className="h-8 min-w-[220px] flex-1 rounded-lg border border-black/10 px-2.5 font-mono text-xs"
              inputMode="numeric"
            />
            <button
              onClick={() => propose("per_tx_cap", { usd: perTx.trim() === "" ? null : Number(perTx) }, "pertx")}
              disabled={busy === "pertx" || !me?.wallet}
              className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40"
            >
              {busy === "pertx" ? "signing…" : "Propose"}
            </button>
          </div>
          {!me?.wallet && <span className="text-[11px] text-[#B3261E]">connect your wallet to sign proposals</span>}
        </div>
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
                  <button onClick={() => decide(r, "deny")} disabled={busy === `decide-${r.id}`} className="rounded-full border border-black/15 px-3 py-1 text-[11px] disabled:opacity-40">
                    Deny
                  </button>
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
      {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
    </div>
  );
}
