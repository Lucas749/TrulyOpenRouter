"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { apiError } from "../../lib/api-error";
import LoginButton from "../components/login-button";
import { useAuthFetch } from "../components/use-auth-fetch";

// Agents workspace: agents get their own credentials with explicit limits,
// funded by a team you belong to or by a personal budget. The gateway enforces
// every limit before a host is paid; over-limit requests wait for a human
// approval instead of silently spending more.

interface Policy {
  dailyCredits: number | null;
  monthlyCredits: number | null;
  lifetimeCredits: number | null;
  maxRequestCredits: number | null;
  models: string[] | null;
  requestsPerMinute: number | null;
  maxConcurrent: number | null;
  credentialTtlDays: number | null;
  exceptions: { credits: boolean };
}

interface AgentRow {
  id: string;
  name: string;
  description: string;
  orgId: string | null;
  sponsorDid: string | null;
  payerKind: "team" | "personal";
  state: "ready" | "paused" | "revoked";
  policy: Policy;
  policyRevision: number;
  ledgerAddress: string | null;
  budgetAddress: string | null;
  createdAt: number;
}

interface Detail {
  agent: AgentRow;
  effective: { monthlyCredits?: number | null; memberAllowance?: number | null; models?: string[] | null; sponsorActive?: boolean };
  usage: { period: string; spent: number; reserved: number; limit: number | null; remaining: number | null }[];
  credentials: { id: string; prefix: string; issuedAt: number; expiresAt: number | null; revokedAt: number | null }[];
  approvals: { id: string; state: string; additionalCredits: number; createdAt: number; limits: { label: string }[] }[];
  receipts: { id: string; ts: number; amountCredits?: string; modelId?: string }[];
}

const GW = "/api/gw/api";
const numberOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);
const periodLabel = (p: string) => (p.startsWith("d:") ? "today" : p.startsWith("m:") ? "this month" : "lifetime");
const STATE_TONE: Record<string, string> = {
  ready: "bg-[#E7F5EE] text-[#0B7A5D]",
  paused: "bg-[#FDF3E2] text-[#8A5300]",
  revoked: "bg-[#FDECEA] text-[#B3261E]",
};

function SetupExample({ secret }: { secret: string }) {
  const origin = window.location.origin;
  return (
    <pre className="m-0 overflow-x-auto rounded-lg bg-[#0D0D0D] p-3 font-mono text-[11px] leading-relaxed text-[#E6EAF0]">{`curl ${origin}/api/gw/v1/chat/completions \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: task-1" \\
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"hello"}],"max_tokens":64}'`}</pre>
  );
}

export default function AgentsPage() {
  const { ready, authenticated } = usePrivy();
  const authFetch = useAuthFetch();
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [teams, setTeams] = useState<{ id: string; display_name: string }[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // creation form
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [funding, setFunding] = useState("personal");
  const [daily, setDaily] = useState("100");
  const [monthly, setMonthly] = useState("");
  const [lifetime, setLifetime] = useState("");
  const [maxRequest, setMaxRequest] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [rpm, setRpm] = useState("30");
  const [concurrent, setConcurrent] = useState("2");
  const [ttl, setTtl] = useState("90");
  const [exceptions, setExceptions] = useState(true);

  useEffect(() => {
    if (!authenticated) return;
    authFetch(`${GW}/agents`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(apiError(d, r.status));
        setAgents(d.data ?? []);
      })
      .catch((e) => setErr(errorText(e)));
    authFetch("/api/team/orgs")
      .then((r) => r.json())
      .then((d) => setTeams(Array.isArray(d.data) ? d.data : []))
      .catch(() => setTeams([]));
    fetch("/api/gw/v1/models")
      .then((r) => r.json())
      .then((d) => setModels(((d.data ?? []) as { id: string }[]).map((m) => m.id)))
      .catch(() => setModels([]));
  }, [authenticated, authFetch]);

  const refresh = useCallback(async () => {
    const r = await authFetch(`${GW}/agents`);
    const d = await r.json();
    if (!r.ok) throw new Error(apiError(d, r.status));
    setAgents(d.data ?? []);
  }, [authFetch]);

  async function openDetail(id: string) {
    const r = await authFetch(`${GW}/agents/${encodeURIComponent(id)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(apiError(d, r.status));
    setDetail(d);
  }

  async function run(tag: string, work: () => Promise<void>) {
    setBusy(tag);
    setErr(null);
    try {
      await work();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const createAgent = () =>
    run("create", async () => {
      setSecret(null);
      const r = await authFetch(`${GW}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          ...(funding === "personal" ? {} : { orgId: funding }),
          policy: {
            dailyCredits: numberOrNull(daily),
            monthlyCredits: numberOrNull(monthly),
            lifetimeCredits: numberOrNull(lifetime),
            maxRequestCredits: numberOrNull(maxRequest),
            models: picked.length ? picked : null,
            requestsPerMinute: numberOrNull(rpm),
            maxConcurrent: numberOrNull(concurrent),
            credentialTtlDays: numberOrNull(ttl),
            exceptions: { credits: exceptions },
          },
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      setSecret({ name: d.agent.name, key: d.key });
      setName("");
      setDescription("");
      await refresh();
      await openDetail(d.agent.id);
    });

  const act = (agent: AgentRow, action: "pause" | "resume" | "revoke" | "rotate") =>
    run(`${action}-${agent.id}`, async () => {
      const r = await authFetch(`${GW}/agents/${encodeURIComponent(agent.id)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      if (action === "rotate") setSecret({ name: agent.name, key: d.key });
      await refresh();
      await openDetail(agent.id);
    });

  const teamName = (orgId: string | null) => (orgId ? teams.find((t) => t.id === orgId)?.display_name ?? orgId : "Personal budget");
  const limitLabel = (v: number | null) => (v === null ? "no limit" : `${v.toLocaleString("en-US")} credits`);

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[960px] items-center justify-between px-6">
          <Link href="/account" className="text-sm text-[#6E6E73] hover:text-black">← Account</Link>
          <span className="text-[15px] font-semibold">Agents</span>
          <LoginButton />
        </div>
      </header>
      <main className="mx-auto flex max-w-[960px] flex-col gap-6 px-6 py-10">
        <p className="m-0 text-sm text-[#6E6E73]">
          Each agent has its own key and limits. Team agents spend team credits within the sponsoring member&apos;s allowance; personal agents spend their own budget.
          When a request would exceed an eligible limit, the agent receives an approval link instead of spending more.
        </p>

        {!ready ? (
          <div className="h-32 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
        ) : !authenticated ? (
          <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-12 text-center">
            <p className="m-0 text-sm text-[#6E6E73]">Log in to create and manage agents.</p>
            <LoginButton />
          </div>
        ) : (
          <>
            <section className="flex flex-col gap-3 rounded-[14px] border border-[#E5E5E0] p-5">
              <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">New agent</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name" className="h-10 flex-1 rounded-lg border border-black/10 px-3 text-sm" />
                <select value={funding} onChange={(e) => setFunding(e.target.value)} className="h-10 rounded-lg border border-black/10 bg-white px-3 text-sm" aria-label="Funding source">
                  <option value="personal">Personal budget</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.display_name} team</option>
                  ))}
                </select>
              </div>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="h-10 rounded-lg border border-black/10 px-3 text-sm" />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Credits per UTC day", daily, setDaily],
                  ["Credits per month", monthly, setMonthly],
                  ["Lifetime ceiling", lifetime, setLifetime],
                  ["Max credits per request", maxRequest, setMaxRequest],
                  ["Requests per minute", rpm, setRpm],
                  ["Concurrent requests", concurrent, setConcurrent],
                  ["Key expiry (days)", ttl, setTtl],
                ].map(([label, value, set]) => (
                  <label key={label as string} className="flex flex-col gap-1 text-[11px] text-[#6E6E73]">
                    {label as string}
                    <input value={value as string} onChange={(e) => (set as (v: string) => void)(e.target.value)} placeholder="no limit" inputMode="numeric" className="h-9 rounded-lg border border-black/10 px-2.5 font-mono text-xs text-black" />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] text-[#6E6E73]">Models (none selected = everything the team allows)</span>
                {models.map((m) => {
                  const on = picked.includes(m);
                  return (
                    <button key={m} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== m) : [...p, m]))} className={`rounded-full border px-3 py-1 font-mono text-[11px] ${on ? "border-black bg-black text-white" : "border-black/10 bg-white"}`}>
                      {m}
                    </button>
                  );
                })}
              </div>
              <label className="flex items-center gap-2 text-xs text-[#5D5D5D]">
                <input type="checkbox" checked={exceptions} onChange={(e) => setExceptions(e.target.checked)} />
                Credit limits may request a human approval (team owner for team agents, an enrolled Ledger for personal agents)
              </label>
              <button onClick={createAgent} disabled={busy === "create" || !name.trim()} className="h-10 rounded-full bg-black text-sm text-white disabled:opacity-40">
                {busy === "create" ? "creating…" : "Create agent"}
              </button>
            </section>

            {secret && (
              <section className="flex flex-col gap-2 rounded-[14px] border border-black p-5">
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Key for {secret.name}, shown once</span>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all rounded-lg bg-[#F4F4F4] px-3 py-2 font-mono text-xs">{secret.key}</span>
                  <button onClick={() => navigator.clipboard?.writeText(secret.key).catch(() => {})} className="rounded-full border border-black/10 px-3 py-1 text-[11px]">Copy</button>
                </div>
                <SetupExample secret={secret.key} />
                <p className="m-0 text-[11px] text-[#6E6E73]">
                  Over an eligible limit the endpoint answers 403 approval_required with an approval_url and poll_after_seconds. Poll GET /api/gw/v1/agent/approvals/&lt;id&gt; with the same key, then retry the original request with the same Idempotency-Key.
                </p>
              </section>
            )}

            <section className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Your agents ({agents?.length ?? "…"})</span>
              {agents?.length === 0 && <p className="m-0 text-sm text-[#8F8F8F]">No agents yet.</p>}
              {(agents ?? []).map((a) => (
                <button key={a.id} onClick={() => run(`open-${a.id}`, () => openDetail(a.id))} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 text-left ${detail?.agent.id === a.id ? "border-black" : "border-[#E5E5E0]"}`}>
                  <span className="text-sm font-medium">{a.name}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${STATE_TONE[a.state]}`}>{a.state}</span>
                  <span className="font-mono text-[11px] text-[#6E6E73]">{teamName(a.orgId)}</span>
                  <span className="ml-auto font-mono text-[11px] text-[#6E6E73]">daily {limitLabel(a.policy.dailyCredits)}</span>
                </button>
              ))}
            </section>

            {detail && (
              <section className="flex flex-col gap-4 rounded-[14px] border border-[#E5E5E0] p-5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-lg">{detail.agent.name}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${STATE_TONE[detail.agent.state]}`}>{detail.agent.state}</span>
                  <span className="font-mono text-[11px] text-[#6E6E73]">{detail.agent.id}</span>
                  <span className="ml-auto flex flex-wrap gap-2">
                    {detail.agent.state === "ready" && (
                      <button onClick={() => act(detail.agent, "pause")} disabled={!!busy} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">Pause</button>
                    )}
                    {detail.agent.state === "paused" && (
                      <button onClick={() => act(detail.agent, "resume")} disabled={!!busy} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">Resume</button>
                    )}
                    {detail.agent.state !== "revoked" && (
                      <>
                        <button onClick={() => act(detail.agent, "rotate")} disabled={!!busy} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">Rotate key</button>
                        <button onClick={() => act(detail.agent, "revoke")} disabled={!!busy} className="rounded-full border border-[#B3261E]/40 px-3 py-1 text-[11px] text-[#B3261E] disabled:opacity-40">Revoke</button>
                      </>
                    )}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {detail.usage.map((u) => (
                    <div key={u.period} className="rounded-lg bg-[#F7F7F5] px-3 py-2">
                      <div className="text-[11px] text-[#6E6E73]">{periodLabel(u.period)}</div>
                      <div className="font-mono text-sm tabular-nums">
                        {u.spent.toLocaleString("en-US")}{u.limit === null ? "" : ` / ${u.limit.toLocaleString("en-US")}`} credits
                      </div>
                      <div className="font-mono text-[11px] text-[#6E6E73]">
                        {u.reserved} reserved · {u.remaining === null ? "no limit" : `${u.remaining} remaining`}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-[#5D5D5D]">
                  <span>funded by {teamName(detail.agent.orgId)}</span>
                  {detail.agent.budgetAddress && <span className="break-all">budget account {detail.agent.budgetAddress}</span>}
                  <span>max per request {limitLabel(detail.agent.policy.maxRequestCredits)}</span>
                  <span>{detail.agent.policy.requestsPerMinute ?? "no"} requests/min</span>
                  <span>{detail.agent.policy.maxConcurrent ?? "no"} concurrent limit</span>
                  <span>models {detail.effective.models ? detail.effective.models.join(", ") : "all allowed"}</span>
                  {detail.effective.memberAllowance !== undefined && <span>sponsor allowance {limitLabel(detail.effective.memberAllowance ?? null)}/month</span>}
                  {detail.effective.sponsorActive === false && <span className="text-[#B3261E]">sponsoring member is no longer active</span>}
                  <span>exceptions {detail.agent.policy.exceptions.credits ? "allowed" : "off"}</span>
                  <span>Ledger {detail.agent.ledgerAddress ? `enrolled ${detail.agent.ledgerAddress}` : "not enrolled"}</span>
                  <span>policy revision {detail.agent.policyRevision}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Keys</span>
                  {detail.credentials.map((c) => (
                    <span key={c.id} className="font-mono text-[11px] text-[#5D5D5D]">
                      {c.prefix}… {c.revokedAt ? "revoked" : c.expiresAt && c.expiresAt < detail.agent.createdAt ? "expired" : c.expiresAt ? `expires ${new Date(c.expiresAt).toISOString().slice(0, 10)}` : "no expiry"}
                    </span>
                  ))}
                </div>
                {detail.approvals.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Approvals</span>
                    {detail.approvals.map((ap) => (
                      <Link key={ap.id} href={`/approvals/${ap.id}`} className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-[#5D5D5D] hover:text-black">
                        <span>{ap.state}</span>
                        <span>+{ap.additionalCredits} credits</span>
                        <span>{ap.limits.map((l) => l.label).join(", ")}</span>
                        <span className="underline">review</span>
                      </Link>
                    ))}
                  </div>
                )}
                {detail.receipts.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Recent requests</span>
                    {detail.receipts.map((r) => (
                      <span key={r.id} className="font-mono text-[11px] text-[#5D5D5D]">
                        {new Date(r.ts).toISOString().replace("T", " ").slice(0, 19)} · {r.modelId} · {r.amountCredits ?? "0"} credits · {r.id.slice(0, 12)}…
                      </span>
                    ))}
                  </div>
                )}
              </section>
            )}
            {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
          </>
        )}
      </main>
    </div>
  );
}
