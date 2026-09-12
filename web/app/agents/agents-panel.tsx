"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { apiError } from "../../lib/api-error";
import { connectLedger, preloadLedgerKit } from "../../lib/ledger-device";
import LoginButton from "../components/login-button";
import { useAuthFetch } from "../components/use-auth-fetch";
import AgentFunding from "./funding";

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

export default function AgentsPanel() {
  const { ready, authenticated } = usePrivy();
  const authFetch = useAuthFetch();
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [teams, setTeams] = useState<{ id: string; display_name: string }[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const keyCard = useRef<HTMLElement | null>(null);

  // A key is shown once, so bring its card into view wherever Create or Rotate key was clicked from.
  useEffect(() => {
    if (secret) keyCard.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [secret]);
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

  const [deviceStep, setDeviceStep] = useState<string | null>(null);
  // Replacing the approver needs both devices; the current device's prompt needs its own click.
  const [replacement, setReplacement] = useState<{ agentId: string; message: string; token: string; signature: string } | null>(null);

  // Load the Ledger kit when an agent opens, so a click reaches the browser's device prompt in time.
  useEffect(() => {
    if (detail) void preloadLedgerKit().catch(() => {});
  }, [detail]);

  /// @notice Sign a gateway challenge on a connected Ledger, returning its verified address and signature.
  async function withLedger<T>(prompt: string, work: (ledger: Awaited<ReturnType<typeof connectLedger>>) => Promise<T>): Promise<T> {
    setDeviceStep(prompt);
    const ledger = await connectLedger(setDeviceStep);
    try {
      return await work(ledger);
    } finally {
      await ledger.close();
      setDeviceStep(null);
    }
  }

  // Enroll (no approver yet), replace (new device, then the current one), or remove (current device).
  // One click opens one device session: the address check and the signature share it, because the
  // browser shows its device prompt only right after a click.
  const changeLedger = (agent: AgentRow, action: "enroll" | "replace" | "remove") =>
    run(`ledger-${agent.id}`, async () => {
      const base = `${GW}/agents/${encodeURIComponent(agent.id)}/ledger`;
      const prompt =
        action === "remove" ? "Approve removing this Ledger on the device" : "Confirm the address on the Ledger, then approve the enrollment message";
      const signed = await withLedger(prompt, async (l) => {
        const address = action === "remove" ? null : await l.verifiedAddress();
        const challengeRes = await authFetch(`${base}/challenge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
        const challenge = await challengeRes.json();
        if (!challengeRes.ok) throw new Error(apiError(challenge, challengeRes.status));
        return { message: challenge.message as string, token: challenge.token as string, signature: await l.signMessage(challenge.message) };
      });
      if (action === "replace") setReplacement({ agentId: agent.id, ...signed });
      else await submitLedgerChange(agent.id, signed);
    }).finally(() => setDeviceStep(null));

  const confirmReplacement = (agent: AgentRow) =>
    run(`ledger-${agent.id}`, async () => {
      if (replacement?.agentId !== agent.id) return;
      const currentSignature = await withLedger("Connect the currently enrolled Ledger and approve the change", (l) => l.signMessage(replacement.message));
      await submitLedgerChange(agent.id, { ...replacement, currentSignature });
      setReplacement(null);
    }).finally(() => setDeviceStep(null));

  async function submitLedgerChange(agentId: string, change: { message: string; token: string; signature: string; currentSignature?: string }) {
    const r = await authFetch(`${GW}/agents/${encodeURIComponent(agentId)}/ledger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: change.message, token: change.token, signature: change.signature, currentSignature: change.currentSignature }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(apiError(d, r.status));
    await openDetail(agentId);
  }

  const teamName = (orgId: string | null) => (orgId ? teams.find((t) => t.id === orgId)?.display_name ?? orgId : "Personal budget");
  const limitLabel = (v: number | null) => (v === null ? "no limit" : `${v.toLocaleString("en-US")} credits`);

  return (
    <div className="flex flex-col gap-6">
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
              <section ref={keyCard} className="flex flex-col gap-2 rounded-[14px] border border-black p-5">
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Key for {secret.name}, shown once</span>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all rounded-lg bg-[#F4F4F4] px-3 py-2 font-mono text-xs">{secret.key}</span>
                  <button
                    onClick={() =>
                      (navigator.clipboard?.writeText(secret.key) ?? Promise.reject()).then(
                        () => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        },
                        () => {},
                      )
                    }
                    className="rounded-full border border-black/10 px-3 py-1 text-[11px]"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
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
                {detail.agent.state !== "revoked" && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-black/15 p-3">
                    <span className="text-xs text-[#5D5D5D]">
                      {detail.agent.ledgerAddress
                        ? "Ledger approvals are on. Replacing or removing the approver needs the enrolled device."
                        : detail.agent.orgId
                          ? "Team owners can enroll a Ledger as an extra approval route for this agent."
                          : "Enroll a Ledger to approve this agent's exceptions and protect its limits."}
                    </span>
                    {!detail.agent.ledgerAddress ? (
                      <button onClick={() => changeLedger(detail.agent, "enroll")} disabled={!!busy} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">Connect Ledger</button>
                    ) : (
                      <>
                        <button onClick={() => changeLedger(detail.agent, "replace")} disabled={!!busy} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">Replace Ledger</button>
                        <button onClick={() => changeLedger(detail.agent, "remove")} disabled={!!busy} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">Remove Ledger</button>
                        {replacement?.agentId === detail.agent.id && (
                          <button onClick={() => confirmReplacement(detail.agent)} disabled={!!busy} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">Approve with the current Ledger</button>
                        )}
                      </>
                    )}
                    {deviceStep && <span className="font-mono text-[11px] text-[#5D5D5D]">{deviceStep}</span>}
                  </div>
                )}
                {!detail.agent.orgId && detail.agent.budgetAddress && (
                  <AgentFunding
                    key={detail.agent.id}
                    agentId={detail.agent.id}
                    ledgerAddress={detail.agent.ledgerAddress}
                    ledgerSign={(prompt, message) => withLedger(prompt, (l) => l.signMessage(message))}
                  />
                )}
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
    </div>
  );
}
