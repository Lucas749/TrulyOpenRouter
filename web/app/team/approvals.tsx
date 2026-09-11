"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuthFetch } from "../components/use-auth-fetch";

// Owner inbox for agent spending approvals in one organization. Only active
// owners receive the list; everyone else sees nothing here.

interface Item {
  id: string;
  state: string;
  additionalCredits: number;
  maximumRequestCredits: number;
  limits: { label: string }[];
  createdAt: number;
  agent: { name: string } | null;
}

export default function TeamApprovals({ orgId, mock }: { orgId: string; mock: boolean }) {
  const authFetch = useAuthFetch();
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (mock) return;
    authFetch(`/api/gw/api/agent-approvals?orgId=${encodeURIComponent(orgId)}`)
      .then(async (r) => setItems(r.ok ? ((await r.json()).data ?? []) : null))
      .catch(() => setItems(null));
  }, [orgId, mock, authFetch]);

  if (!items) return null;
  const pending = items.filter((i) => i.state === "pending");
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#E5E5E0] px-4 py-3">
      <button onClick={() => setOpen((o) => !o)} className="flex flex-wrap items-baseline gap-x-3 text-left">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Agent approvals ({pending.length} pending)</span>
        <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">owner decisions, no Ledger needed</span>
        <span className={`font-mono text-xs text-[#8F8F8F] transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          {items.length === 0 && <p className="m-0 text-sm text-[#8F8F8F]">No agent approval requests yet.</p>}
          {items.slice(0, 20).map((i) => (
            <Link key={i.id} href={`/approvals/${i.id}`} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 ${i.state === "pending" ? "bg-[#FDF3E2]" : "bg-[#F7F7F5]"}`}>
              <span className="text-sm">{i.agent?.name ?? "agent"}</span>
              <span className="font-mono text-xs tabular-nums">+{i.additionalCredits} credits</span>
              <span className="font-mono text-[11px] text-[#6E6E73]">{i.limits.map((l) => l.label).join(", ")}</span>
              <span className="ml-auto font-mono text-[11px] text-[#6E6E73]">{i.state}</span>
              <span className="text-[11px] underline">review</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
