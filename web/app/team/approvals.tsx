"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSignMessage } from "@privy-io/react-auth";
import { apiError } from "../../lib/api-error";
import { connectLedger, preloadLedgerKit } from "../../lib/ledger-device";
import { useAuthFetch } from "../components/use-auth-fetch";

// Waiting on you: the agent spending requests this organization's owner can decide
// without leaving the team page. Approving signs the exact server-built message —
// with a wallet linked to the login, or on the agent's enrolled Ledger — and grants
// the listed extra credits for that one request only.

interface Item {
  id: string;
  state: string;
  additionalCredits: number;
  maximumRequestCredits: number;
  limits: { label: string }[];
  createdAt: number;
  agent: { name: string } | null;
}

interface Detail {
  approval: { id: string; state: string; additionalCredits: number; memberDid: string | null; model: string; limits: { label: string; limit: number }[] };
  agent: { id: string; name: string };
  message: string;
  canApprove: { org_owner: boolean; ledger: boolean };
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);
const fmt = (n: number) => n.toLocaleString("en-US");

const Glyph = ({ d, size = 17 }: { d: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const ASK_ICON = (
  <>
    <path d="M18 11V6a2 2 0 0 0-4 0v5" />
    <path d="M14 10V4a2 2 0 0 0-4 0v6" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v10" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8" />
  </>
);

export default function TeamApprovals({ orgId, mock }: { orgId: string; mock: boolean }) {
  const authFetch = useAuthFetch();
  const { signMessage } = useSignMessage();
  const [items, setItems] = useState<Item[] | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [deviceStep, setDeviceStep] = useState<string | null>(null);

  // Each pending request is opened once, because only the detail carries the exact
  // message to sign and which routes this login may actually use.
  const load = useCallback(async () => {
    if (mock) return;
    try {
      const r = await authFetch(`/api/gw/api/agent-approvals?orgId=${encodeURIComponent(orgId)}`);
      if (!r.ok) {
        setItems([]);
        return;
      }
      const rows: Item[] = (await r.json()).data ?? [];
      setItems(rows);
      const pending = rows.filter((i) => i.state === "pending");
      const loaded = await Promise.all(
        pending.map(async (i) => {
          const d = await authFetch(`/api/gw/api/agent-approvals/${encodeURIComponent(i.id)}`);
          return d.ok ? ([i.id, (await d.json()) as Detail] as const) : null;
        }),
      );
      setDetails(Object.fromEntries(loaded.filter((x): x is [string, Detail] => !!x)));
    } catch {
      setItems([]);
    }
  }, [authFetch, orgId, mock]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const pending = (items ?? []).filter((i) => i.state === "pending");
  const anyLedger = pending.some((i) => details[i.id]?.canApprove.ledger);
  useEffect(() => {
    if (anyLedger) void preloadLedgerKit().catch(() => {});
  }, [anyLedger]);

  async function decide(id: string, decision: "approve" | "deny", method: "org_owner" | "ledger") {
    const detail = details[id];
    if (!detail) return;
    setBusy(`${decision}-${id}`);
    setErr(null);
    try {
      let signature: string | undefined;
      if (decision === "approve" && method === "org_owner") signature = (await signMessage({ message: detail.message })).signature;
      if (decision === "approve" && method === "ledger") {
        setDeviceStep("Select your Ledger and open the Ethereum app");
        const ledger = await connectLedger(setDeviceStep);
        try {
          signature = await ledger.signMessage(detail.message);
        } finally {
          await ledger.close();
          setDeviceStep(null);
        }
      }
      const r = await authFetch(`/api/gw/api/agent-approvals/${encodeURIComponent(id)}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, method, signature }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      await load();
    } catch (e) {
      setDeviceStep(null);
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (mock || !items || pending.length === 0) return null;

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5">
        <h2 className="m-0 text-[19px] font-medium tracking-[-0.02em]">Waiting on you</h2>
        <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-[#FDF3E2] px-2.5 text-[11px] text-[#8A5300]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#D97706]" />
          {pending.length} item{pending.length === 1 ? "" : "s"}
        </span>
      </div>

      {pending.map((i) => {
        const detail = details[i.id];
        const ledgerRoute = !!detail?.canApprove.ledger;
        const ownerRoute = !!detail?.canApprove.org_owner;
        const method: "org_owner" | "ledger" = ownerRoute ? "org_owner" : "ledger";
        return (
          <div key={i.id} className="flex flex-wrap items-center gap-[18px] rounded-[14px] border border-[#F2E1C4] bg-white p-[18px_20px]">
            <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[#FDF3E2] text-[#8A5300]">
              <Glyph d={ASK_ICON} />
            </span>
            <div className="flex min-w-[220px] flex-col gap-1">
              <span className="text-[15px]">{i.agent?.name ?? "agent"} wants more credits</span>
              <span className="font-mono text-[12px] tabular-nums text-[#5D5D5D]">
                agent · {i.limits.map((l) => l.label).join(", ")}
                {detail?.approval.memberDid ? ` · sponsored by ${detail.approval.memberDid.replace(/^did:privy:/, "").slice(0, 12)}` : ""}
              </span>
            </div>
            <div className="ml-auto flex w-[120px] flex-col gap-0.5">
              <span className="text-[11px] text-[#5D5D5D]">requesting</span>
              <span className="whitespace-nowrap font-mono text-[17px] tabular-nums">+{fmt(i.additionalCredits)} cr</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => decide(i.id, "approve", method)}
                disabled={!!busy || !detail || (!ownerRoute && !ledgerRoute)}
                title={!detail ? "loading" : !ownerRoute && !ledgerRoute ? "This login cannot decide this request" : undefined}
                className="flex h-9 items-center justify-center whitespace-nowrap rounded-full bg-[#0D0D0D] px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#2F2F2F] disabled:bg-[#D4D4CF]"
              >
                {busy === `approve-${i.id}` ? (deviceStep ? "confirm on Ledger…" : "sign in wallet…") : ledgerRoute && !ownerRoute ? "Approve with Ledger" : "Approve"}
              </button>
              <button
                onClick={() => decide(i.id, "deny", method)}
                disabled={!!busy || !detail}
                className="h-9 w-[78px] shrink-0 rounded-full border border-[#E5E5E0] bg-white text-[13px] text-[#B3261E] transition-colors hover:bg-[#FDECEA] disabled:opacity-40"
              >
                {busy === `deny-${i.id}` ? "denying…" : "Deny"}
              </button>
            </div>
            <Link href={`/approvals/${i.id}`} className="w-full text-[12px] text-[#5D5D5D] underline underline-offset-2 hover:text-[#0D0D0D]">
              Read the exact message before signing →
            </Link>
          </div>
        );
      })}

      {deviceStep && <p className="m-0 font-mono text-[11px] text-[#5D5D5D]">{deviceStep}</p>}
      {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
    </section>
  );
}
