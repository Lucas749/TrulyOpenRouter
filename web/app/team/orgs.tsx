"use client";

import { useEffect, useState } from "react";
import { apiError } from "../../lib/api-error";
import { hbarWeiToHbar, hbarWeiToUsd, usdToHbarWei } from "../../lib/fx";
import { useAuthFetch } from "../components/use-auth-fetch";
import OrgMembers from "./members";
import OrgRules from "./rules";

export interface TeamOrg {
  id: string;
  display_name: string;
  default_key_quorum_id: string;
  wallets?: { id: string; address: string; policy_ids: string[] }[];
}

// Full team stack in one component: create (quorum → org → wallet + policy),
// Privy wallets with policy counts, and the member / allowance / inbox manager.
// Rendered on /team and inside account → Team. Every call carries the login token.
export default function TeamOrgs({
  me,
  mock,
}: {
  me: { did: string; wallet: string | null; email: string | null } | null;
  mock: boolean;
}) {
  const authFetch = useAuthFetch();
  const [orgs, setOrgs] = useState<TeamOrg[] | null>(null);
  const [name, setName] = useState("");
  const [capUsd, setCapUsd] = useState("25");
  const capPreview = (() => {
    try {
      const hbar = hbarWeiToHbar(usdToHbarWei(Number(capUsd)));
      return `≈ ${hbar.toLocaleString("en-US", { maximumFractionDigits: 2 })} HBAR/tx`;
    } catch {
      return null;
    }
  })();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<any | null>(null);
  const [caps, setCaps] = useState<Record<string, string>>({});

  async function load() {
    if (mock) {
      // Mock swaps ENTIRELY to fixtures: one fixture org + fixture members.
      const { MOCK_TEAM_ORG } = await import("../../lib/mock");
      setOrgs([{ id: MOCK_TEAM_ORG.id, display_name: "Acme (mock)", default_key_quorum_id: "quorum_mock", wallets: [] }]);
      return;
    }
    try {
      // Your orgs only (created by you, member of, or invited to) — the server
      // derives identity from the login token.
      const r: any = await (await authFetch("/api/team/orgs")).json();
      setOrgs(r.data ?? []);
    } catch {
      setOrgs([]);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mock, me?.did]);

  // Spending-cap policies in plain dollars (parsed from the Privy rule wei).
  async function capFor(walletId: string): Promise<string | null> {
    if (caps[walletId] !== undefined) return caps[walletId] || null;
    try {
      const d: any = await (await authFetch(`/api/team/wallets/${walletId}/policies`)).json();
      const rule = (d.policies ?? []).flatMap((p: any) => p.rules ?? []).find((r: any) => r?.conditions?.[0]?.value);
      const usd = rule ? hbarWeiToUsd(rule.conditions[0].value) : NaN;
      const label = Number.isFinite(usd) ? `spending cap $${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}/tx` : "";
      setCaps((m) => ({ ...m, [walletId]: label }));
      return label || null;
    } catch {
      setCaps((m) => ({ ...m, [walletId]: "" }));
      return null;
    }
  }

  useEffect(() => {
    if (mock) return;
    for (const o of orgs ?? []) for (const w of o.wallets ?? []) void capFor(w.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgs, mock]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    setCreated(null);
    try {
      // USD-termed cap → HBAR wei policy (native on our chain). Empty = no cap.
      const r = await authFetch("/api/team/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          ...(capUsd.trim() ? { capUsd: Number(capUsd) } : {}),
        }),
      });
      const d: any = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      setCreated(d);
      setName("");
      await load();
    } catch (e: any) {
      setMsg(String(e?.message ?? e).slice(0, 200));
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-6">
      {!mock && (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" className="h-10 flex-[2] rounded-lg border border-black/10 px-3 text-sm" />
              <input value={capUsd} onChange={(e) => setCapUsd(e.target.value)} placeholder="spending cap (USD)" title="Per-transaction spending-cap policy in USD, enforced in HBAR" className="h-10 flex-1 rounded-lg border border-black/10 px-3 font-mono text-sm" inputMode="decimal" />
              <button onClick={create} disabled={busy || !name.trim()} className="h-10 rounded-full bg-black px-5 text-sm text-white disabled:opacity-40">{busy ? "creating…" : "Create team"}</button>
            </div>
            {capPreview && <span className="font-mono text-[11px] text-[#6E6E73]">cap {capPreview}, enforced onchain per transaction</span>}
          </div>
          {msg && <p className="m-0 font-mono text-xs text-[#B3261E]">{msg}</p>}
          {created && (
            <div className="flex flex-col gap-1.5 rounded-[14px] border border-[#10A37F] p-4 font-mono text-xs">
              <span className="text-[#0B7A5D]">✓ team live, quorum → org → wallet</span>
              <span>org {created.org.id}</span>
              <span>wallet {created.wallet.address}</span>
            </div>
          )}
        </>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Teams ({orgs?.length ?? "…"})</span>
        {(orgs ?? []).map((o) => (
          <div key={o.id} className="flex flex-col gap-2 rounded-xl border border-[#E5E5E0] px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 text-sm">
              <span className="font-medium">{o.display_name}</span>
              <span className="font-mono text-xs text-[#6E6E73]">{o.id}</span>
              <details className="ml-auto font-mono text-[11px] text-[#8F8F8F]">
                <summary className="cursor-pointer underline">technical details</summary>
                quorum {o.default_key_quorum_id} · {(o.wallets ?? []).map((w) => w.id).join(", ")}
              </details>
            </div>
            <OrgMembers orgId={o.id} me={me} mock={mock} />
            <OrgRules orgId={o.id} me={me} mock={mock} />
            {(o.wallets ?? []).map((w) => (
              <div key={w.id} className="flex flex-col gap-2 rounded-lg bg-[#F7F7F5] p-3">
                <div className="flex flex-wrap items-center gap-x-2 font-mono text-xs">
                  <span>{w.address.slice(0, 12)}…</span>
                  <span className="text-[#0B7A5D]">{caps[w.id] ? `✓ ${caps[w.id]}` : w.policy_ids.length ? "policy attached" : "no policy"}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
        {orgs && !orgs.length && <p className="m-0 text-sm text-[#8F8F8F]">no teams yet, create the first above</p>}
      </div>
    </div>
  );
}
