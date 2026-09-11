"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePrivy, useSignMessage } from "@privy-io/react-auth";
import { apiError } from "../../../lib/api-error";
import LoginButton from "../../components/login-button";
import { useAuthFetch } from "../../components/use-auth-fetch";

// Review one agent spending approval. An owner of the agent's organization
// approves by signing the exact server-built message with a wallet linked to
// their login. The decision grants the listed extra credits for this one
// request only; it never moves wallet funds or changes policies.

interface Limit {
  subject: string;
  period: string;
  label: string;
  limit: number;
  extra: number;
}

interface ApprovalView {
  approval: {
    id: string;
    orgId: string | null;
    memberDid: string | null;
    methods: ("org_owner" | "ledger")[];
    model: string;
    maximumRequestCredits: number;
    additionalCredits: number;
    limits: Limit[];
    policyRevision: number;
    membershipRevision: number;
    ledgerRevision: number;
    expiresAt: number;
    state: string;
    decidedAt: number | null;
    grantExpiresAt: number | null;
  };
  agent: { id: string; name: string; payerKind: string; orgId: string | null };
  message: string;
  canApprove: { org_owner: boolean; ledger: boolean };
  evidence: { method: string; signer: string; actorUserId: string; verifiedAt: number } | null;
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);
const STATE_TONE: Record<string, string> = {
  pending: "bg-[#FDF3E2] text-[#8A5300]",
  approved: "bg-[#E7F5EE] text-[#0B7A5D]",
  reserved: "bg-[#E7F5EE] text-[#0B7A5D]",
  consumed: "bg-[#F4F4F4] text-[#5D5D5D]",
};

export default function ApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const { ready, authenticated } = usePrivy();
  const { signMessage } = useSignMessage();
  const authFetch = useAuthFetch();
  const [view, setView] = useState<ApprovalView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const path = `/api/gw/api/agent-approvals/${encodeURIComponent(id)}`;

  useEffect(() => {
    if (!authenticated) return;
    authFetch(path)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(apiError(d, r.status));
        setView(d);
      })
      .catch((e) => setErr(errorText(e)));
  }, [authenticated, authFetch, path]);

  const reload = useCallback(async () => {
    const r = await authFetch(path);
    const d = await r.json();
    if (!r.ok) throw new Error(apiError(d, r.status));
    setView(d);
  }, [authFetch, path]);

  async function decide(decision: "approve" | "deny", method: "org_owner" | "ledger") {
    if (!view) return;
    setBusy(decision);
    setErr(null);
    try {
      const signature = decision === "approve" ? (await signMessage({ message: view.message })).signature : undefined;
      const r = await authFetch(`${path}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, method, signature }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      await reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const a = view?.approval;
  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/agents" className="text-sm text-[#6E6E73] hover:text-black">← Agents</Link>
          <span className="text-[15px] font-semibold">Spending approval</span>
          <LoginButton />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-5 px-6 py-10">
        {!ready ? (
          <div className="h-32 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
        ) : !authenticated ? (
          <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-12 text-center">
            <p className="m-0 text-sm text-[#6E6E73]">Log in as the organization owner or agent owner to review this request.</p>
            <LoginButton />
          </div>
        ) : !view || !a ? (
          err ? null : <div className="h-32 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
        ) : (
          <>
            <section className="flex flex-col gap-3 rounded-[14px] border border-[#E5E5E0] p-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-lg">{view.agent.name}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${STATE_TONE[a.state] ?? "bg-[#FDECEA] text-[#B3261E]"}`}>{a.state}</span>
                <span className="ml-auto font-mono text-[11px] text-[#6E6E73]">{a.id}</span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[
                  ["Additional credits", String(a.additionalCredits)],
                  ["Request maximum", `${a.maximumRequestCredits} credits`],
                  ["Model", a.model],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-[#F7F7F5] px-3 py-2">
                    <div className="text-[11px] text-[#6E6E73]">{label}</div>
                    <div className="font-mono text-sm">{value}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1 font-mono text-[11px] text-[#5D5D5D]">
                <span>payer: {a.orgId ? `team ${a.orgId}` : "personal budget"}</span>
                {a.memberDid && <span>sponsoring member: {a.memberDid}</span>}
                {a.limits.map((l) => (
                  <span key={`${l.subject}${l.period}`}>
                    limit reached: {l.label} {l.limit} → +{l.extra} for this request
                  </span>
                ))}
                <span>grant: this exact request once, within 5 minutes of approval</span>
                <span>revisions: policy {a.policyRevision}, membership {a.membershipRevision}, Ledger {a.ledgerRevision}</span>
                <span>decision window ends {new Date(a.expiresAt).toISOString().replace("T", " ").slice(0, 19)} UTC</span>
                <span>network: Hedera testnet</span>
              </div>
              <p className="m-0 text-[11px] text-[#8F8F8F]">
                Approving adds credits for one request within the team&apos;s existing funds. It does not move wallet funds, change policies, or raise any other limit.
              </p>
            </section>

            {a.state === "pending" && (view.canApprove.org_owner || view.canApprove.ledger) && (
              <section className="flex flex-wrap items-center gap-3">
                {view.canApprove.org_owner && (
                  <button onClick={() => decide("approve", "org_owner")} disabled={!!busy} className="h-10 rounded-full bg-black px-5 text-sm text-white disabled:opacity-40">
                    {busy === "approve" ? "sign in wallet…" : "Approve spending increase"}
                  </button>
                )}
                <button onClick={() => decide("deny", view.canApprove.org_owner ? "org_owner" : "ledger")} disabled={!!busy} className="h-10 rounded-full border border-black/15 px-5 text-sm disabled:opacity-40">
                  {busy === "deny" ? "denying…" : "Deny"}
                </button>
              </section>
            )}
            {a.state === "pending" && !view.canApprove.org_owner && !view.canApprove.ledger && (
              <p className="m-0 text-sm text-[#6E6E73]">Waiting for {a.methods.includes("org_owner") ? "an owner of the organization" : "the agent's enrolled Ledger"} to decide.</p>
            )}
            {view.evidence && (
              <p className="m-0 font-mono text-[11px] text-[#5D5D5D]">
                decided by {view.evidence.method === "org_owner" ? "organization owner" : "enrolled Ledger"} {view.evidence.signer} at {new Date(view.evidence.verifiedAt).toISOString().replace("T", " ").slice(0, 19)} UTC
              </p>
            )}
            <details className="text-[11px] text-[#8F8F8F]">
              <summary className="cursor-pointer underline">exact message you sign</summary>
              <pre className="m-0 mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-[#F7F7F5] p-3 font-mono text-[11px] text-[#424242]">{view.message}</pre>
            </details>
          </>
        )}
        {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
      </main>
    </div>
  );
}
