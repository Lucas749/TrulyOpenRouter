"use client";

import { useEffect, useState, type ReactNode } from "react";
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

const Glyph = ({ d, size = 14 }: { d: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const PRIVY_ICON = (
  <>
    <path d="M2 9V5a2 2 0 0 1 2-2h3" />
    <path d="M19 3h1a2 2 0 0 1 2 2v4" />
    <path d="M22 15v4a2 2 0 0 1-2 2h-1" />
    <path d="M7 21H4a2 2 0 0 1-2-2v-4" />
    <circle cx="12" cy="12" r="3" />
  </>
);
const LEDGER_ICON = (
  <>
    <rect x="2" y="7" width="20" height="10" rx="2" />
    <path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" />
  </>
);

function Badge({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-[#E5E5E0] px-3 text-[12px] text-[#424242]">
      <Glyph d={icon} />
      {children}
    </span>
  );
}

// Full team stack in one page: create (the gateway provisions a Privy
// organization wallet owned by you and the broker key, with the treasury
// policy), the compute treasury, what is waiting on a human, seats and
// allowances, the firm rules, and the team's hosts.
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
  const [showCreate, setShowCreate] = useState(false);

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
      const r = (await (await authFetch("/api/team/orgs")).json()) as { data?: TeamOrg[] };
      setOrgs(r.data ?? []);
    } catch {
      setOrgs([]);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mock, me?.did]);

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
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      setCreated(d as { org: { id: string }; wallet: { address: string } });
      setName("");
      setShowCreate(false);
      await load();
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e).slice(0, 200));
    }
    setBusy(false);
  }

  const empty = orgs !== null && orgs.length === 0;

  return (
    <div className="flex flex-col gap-10">
      {(empty || showCreate) && !mock && (
        <div className="flex flex-col gap-2 rounded-[14px] border border-dashed border-[#E5E5E0] p-5">
          <span className="text-[15px] font-medium">{empty ? "Start a team" : "New team"}</span>
          <span className="text-[13px] text-[#5D5D5D]">
            Creating a team provisions a key quorum, an organization and a Privy wallet with the treasury policy attached — in one call.
          </span>
          <div className="mt-1 flex flex-wrap gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Team name"
              className="h-10 min-w-[200px] flex-1 rounded-xl border border-[#E5E5E0] bg-white px-3.5 text-sm outline-none focus:border-black/40"
            />
            <button
              onClick={create}
              disabled={busy || !name.trim()}
              className="flex h-10 shrink-0 items-center rounded-full bg-[#0D0D0D] px-5 text-sm font-medium text-white transition-colors hover:bg-[#2F2F2F] disabled:bg-[#D4D4CF]"
            >
              {busy ? "creating…" : "Create team"}
            </button>
          </div>
          <span className="text-[12px] text-[#5D5D5D]">You become the owner and the financial approver — every treasury transaction needs your signature.</span>
        </div>
      )}

      {msg && <p className="m-0 font-mono text-xs text-[#B3261E]">{msg}</p>}
      {created && (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-[#10A37F] p-4 font-mono text-xs">
          <span className="text-[#0B7A5D]">✓ team wallet active, policy attached</span>
          <span>org {created.org.id}</span>
          <span>wallet {created.wallet.address}</span>
        </div>
      )}

      {orgs === null && <div className="h-40 animate-pulse rounded-[14px] bg-[#F4F4F4]" />}

      {(orgs ?? []).map((o) => (
        <div key={o.id} className="flex flex-col gap-7">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2.5">
                <h1 className="m-0 text-[34px] font-normal tracking-[-0.03em]">{o.display_name}</h1>
                <span className="inline-flex h-6 items-center rounded-full bg-[#F4F4F4] px-2.5 text-[12px] text-[#424242]">team plan</span>
              </div>
              <p className="m-0 max-w-[620px] text-[15px] leading-[1.6] text-[#5D5D5D]">
                One compute wallet for the whole team. Every seat and every agent spends against it under limits the wallet itself enforces — an agent that hits its
                ceiling asks you for more instead of spending it.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge icon={PRIVY_ICON}>Wallet by Privy</Badge>
              <Badge icon={LEDGER_ICON}>Ledger in the loop</Badge>
            </div>
          </div>

          <TeamTreasury orgId={o.id} mock={mock} />
          <TeamApprovals orgId={o.id} mock={mock} />
          <OrgMembers orgId={o.id} me={me} mock={mock} />
          <OrgRules orgId={o.id} me={me} mock={mock} />
          <TeamHosts orgId={o.id} mock={mock} />

          <div className="flex items-center gap-3">
            <details className="font-mono text-[11px] text-[#8F8F8F]">
              <summary className="cursor-pointer">technical details</summary>
              <span className="break-all">
                org {o.id} · quorum {o.default_key_quorum_id} ·{" "}
                {(o.wallets ?? []).map((w) => `${w.id} ${w.address} ${w.policy_ids.length ? "policy attached" : "no policy"}`).join(", ")}
              </span>
            </details>
            {!mock && !showCreate && (
              <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] text-[#5D5D5D] underline underline-offset-2 hover:text-[#0D0D0D]">
                New team
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
