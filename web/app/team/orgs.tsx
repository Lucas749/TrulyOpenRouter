"use client";

import { useEffect, useState } from "react";
import { apiError } from "../../lib/api-error";
import { useAuthFetch } from "../components/use-auth-fetch";
import OrgMembers from "./members";
import OrgRules from "./rules";
import TeamTreasury from "./treasury";
import TeamApprovals from "./approvals";
import TeamHosts from "./hosts";

export interface TeamOrg {
  id: string;
  display_name: string;
  default_key_quorum_id: string;
  wallets?: { id: string; address: string; policy_ids: string[] }[];
}

// Full team stack in one component: create (the gateway provisions a Privy
// organization wallet owned by you and the broker key, with the treasury
// policy), wallet policy summary, and the member / allowance / inbox manager.
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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<{ org: { id: string }; wallet: { address: string } } | null>(null);
  const [policies, setPolicies] = useState<Record<string, string>>({});

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

  // Policy summary: the rule names Privy enforces on the team wallet.
  async function policyFor(walletId: string) {
    if (policies[walletId] !== undefined) return;
    try {
      const d: any = await (await authFetch(`/api/team/wallets/${walletId}/policies`)).json();
      const names = (d.policies ?? []).flatMap((p: any) => (p.rules ?? []).map((r: any) => r.name));
      setPolicies((m) => ({ ...m, [walletId]: names.join(", ") }));
    } catch {
      setPolicies((m) => ({ ...m, [walletId]: "" }));
    }
  }

  useEffect(() => {
    if (mock) return;
    for (const o of orgs ?? []) for (const w of o.wallets ?? []) void policyFor(w.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgs, mock]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    setCreated(null);
    try {
      const r = await authFetch("/api/team/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
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
              <button onClick={create} disabled={busy || !name.trim()} className="h-10 rounded-full bg-black px-5 text-sm text-white disabled:opacity-40">{busy ? "creating…" : "Create team"}</button>
            </div>
            <span className="font-mono text-[11px] text-[#6E6E73]">You become the owner and approve every Compute Treasury transaction.</span>
          </div>
          {msg && <p className="m-0 font-mono text-xs text-[#B3261E]">{msg}</p>}
          {created && (
            <div className="flex flex-col gap-1.5 rounded-[14px] border border-[#10A37F] p-4 font-mono text-xs">
              <span className="text-[#0B7A5D]">✓ team wallet active, policy attached</span>
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
                quorum {o.default_key_quorum_id} ·{" "}
                {(o.wallets ?? []).map((w) => `${w.id} ${w.address} ${policies[w.id] ? `policy: ${policies[w.id]}` : w.policy_ids.length ? "policy attached" : "no policy"}`).join(", ")}
              </details>
            </div>
            <OrgMembers orgId={o.id} me={me} mock={mock} />
            <OrgRules orgId={o.id} me={me} mock={mock} />
            <TeamTreasury orgId={o.id} mock={mock} />
            <TeamHosts orgId={o.id} mock={mock} />
            <TeamApprovals orgId={o.id} mock={mock} />
          </div>
        ))}
        {orgs && !orgs.length && <p className="m-0 text-sm text-[#8F8F8F]">no teams yet, create the first above</p>}
      </div>
    </div>
  );
}
