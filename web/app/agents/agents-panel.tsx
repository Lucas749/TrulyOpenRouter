"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { apiError } from "../../lib/api-error";
import { connectLedger, preloadLedgerKit } from "../../lib/ledger-device";
import LoginButton from "../components/login-button";
import { useAuthFetch } from "../components/use-auth-fetch";
import { useDemo } from "../components/mock";
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
  regions: string[] | null;
  verifiedOnly: boolean;
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

interface Usage {
  period: string;
  spent: number;
  reserved: number;
  limit: number | null;
  remaining: number | null;
}

interface Detail {
  agent: AgentRow;
  effective: { monthlyCredits?: number | null; memberAllowance?: number | null; models?: string[] | null; sponsorActive?: boolean };
  usage: Usage[];
  credentials: { id: string; prefix: string; issuedAt: number; expiresAt: number | null; revokedAt: number | null }[];
  approvals: { id: string; state: string; additionalCredits: number; createdAt: number; limits: { label: string }[] }[];
  receipts: { id: string; ts: number; amountCredits?: string; modelId?: string }[];
}

const GW = "/api/gw/api";
const numberOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);
const fmt = (n: number) => n.toLocaleString("en-US");
const todayOf = (u: Usage[]) => u.find((x) => x.period.startsWith("d:")) ?? null;
const periodLabel = (p: string) => (p.startsWith("d:") ? "Today" : p.startsWith("m:") ? "This month" : "Lifetime");

const STATUS_PILL: Record<string, { bg: string; fg: string; dot: string; pulse: boolean }> = {
  ready: { bg: "bg-[#E7F5EE]", fg: "text-[#0B7A5D]", dot: "bg-[#10A37F]", pulse: false },
  "at ceiling": { bg: "bg-[#FDF3E2]", fg: "text-[#8A5300]", dot: "bg-[#D97706]", pulse: true },
  paused: { bg: "bg-[#F4F4F4]", fg: "text-[#424242]", dot: "bg-[#8F8F8F]", pulse: false },
  revoked: { bg: "bg-[#FDECEA]", fg: "text-[#B3261E]", dot: "bg-[#DC2626]", pulse: false },
};

/// @notice Design glyphs, inlined so the page owns its icons and pulls in no icon set.
const Glyph = ({ d, size = 15 }: { d: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const CHIP_ICON = <path d="M4 4h16v16H4zM9 9h6v6H9zM15 2v2M9 2v2M15 20v2M9 20v2M20 15h2M20 9h2M2 15h2M2 9h2" />;
const LEDGER_ICON = (
  <>
    <rect x="2" y="7" width="20" height="10" rx="2" />
    <path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" />
  </>
);
const OWNER_ICON = (
  <>
    <path d="M18 11V6a2 2 0 0 0-4 0v5" />
    <path d="M14 10V4a2 2 0 0 0-4 0v6" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v10" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8" />
  </>
);
const STOP_ICON = (
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="m15 9-6 6M9 9l6 6" />
  </>
);
const KEY_ICON = (
  <>
    <path d="m2 18 8-8" />
    <circle cx="16.5" cy="7.5" r="4.5" />
    <path d="m5 15 2 2" />
    <path d="m2 22 2-2" />
  </>
);
const SHIELD_ICON = (
  <>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </>
);
const CHECK_ICON = <path d="m5 12 5 5L20 7" />;
const COPY_ICON = (
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>
);

const cardBtn = "flex h-full flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-colors";
const pill = "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 font-mono text-[12px] transition-colors";
const ghost = "h-[34px] rounded-full border border-[#E5E5E0] bg-white px-3.5 text-[13px] text-[#0D0D0D] transition-colors hover:bg-[#F4F4F4] disabled:opacity-40";

function Row({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="grid gap-6 sm:grid-cols-[minmax(120px,150px)_minmax(0,1fr)] sm:items-start">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-[12px] leading-[1.55] text-[#5D5D5D]">{note}</span>
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, onChange, unit, placeholder = "no limit" }: { label: string; value: string; onChange: (v: string) => void; unit: string; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] text-[#5D5D5D]">{label}</span>
      <span className="flex items-center rounded-[10px] border border-[#E5E5E0] bg-white">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode="numeric"
          className="h-[38px] w-full min-w-0 rounded-[10px] bg-transparent px-2.5 text-right font-mono text-[13px] tabular-nums text-[#0D0D0D] outline-none"
        />
        <span className="shrink-0 whitespace-nowrap pl-1 pr-2.5 text-[11px] text-[#5D5D5D]">{unit}</span>
      </span>
    </label>
  );
}

function Stat({ label, value, note, tone = "plain" }: { label: string; value: string; note: ReactNode; tone?: "plain" | "amber" }) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-[14px] border p-[18px_20px] ${tone === "amber" ? "border-[#F2E1C4] bg-[#FDF3E2]" : "border-[#E5E5E0]"}`}>
      <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">{label}</span>
      <span className={`font-mono text-[26px] leading-none tracking-[-0.025em] tabular-nums ${tone === "amber" ? "text-[#8A5300]" : ""}`}>{value}</span>
      <span className="text-[12px] text-[#5D5D5D]">{note}</span>
    </div>
  );
}

function CopyButton({ text, label, dark = false }: { text: string; label: string; dark?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      onClick={() =>
        (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          },
          () => {},
        )
      }
      className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border transition-colors ${
        dark ? "border-[#333333] text-[#E6E6E6] hover:bg-white/10" : "border-[#E5E5E0] bg-white hover:bg-[#F4F4F4]"
      } ${done ? (dark ? "text-[#10A37F]" : "text-[#0B7A5D]") : ""}`}
    >
      <Glyph size={14} d={done ? CHECK_ICON : COPY_ICON} />
    </button>
  );
}

export default function AgentsPanel() {
  const { ready, authenticated } = usePrivy();
  const [demo] = useDemo();
  const authFetch = useAuthFetch();
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [teams, setTeams] = useState<{ id: string; display_name: string }[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [regionList, setRegionList] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const keyCard = useRef<HTMLElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // form (create, and edit limits on an existing agent)
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AgentRow | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [funding, setFunding] = useState("personal");
  const [daily, setDaily] = useState("100");
  const [monthly, setMonthly] = useState("");
  const [lifetime, setLifetime] = useState("");
  const [maxRequest, setMaxRequest] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedRegions, setPickedRegions] = useState<string[]>([]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [rpm, setRpm] = useState("30");
  const [concurrent, setConcurrent] = useState("2");
  const [ttl, setTtl] = useState("90");
  const [exceptions, setExceptions] = useState(true);

  // A key is shown once, so bring its card into view wherever Create or Rotate key was clicked from.
  useEffect(() => {
    if (secret) keyCard.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [secret]);

  /// @notice The list carries no usage, so every agent's detail is pulled once — that is what makes
  /// the meters, the spend bars and the counters above real rather than decorative.
  const loadDetail = useCallback(
    async (id: string) => {
      const r = await authFetch(`${GW}/agents/${encodeURIComponent(id)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      setDetails((m) => ({ ...m, [id]: d }));
      return d as Detail;
    },
    [authFetch],
  );

  const refresh = useCallback(async () => {
    const r = await authFetch(`${GW}/agents`);
    const d = await r.json();
    if (!r.ok) throw new Error(apiError(d, r.status));
    const rows: AgentRow[] = d.data ?? [];
    setAgents(rows);
    await Promise.all(rows.map((a) => loadDetail(a.id).catch(() => null)));
  }, [authFetch, loadDetail]);

  // Deferred off the effect body, so loading state never lands in the same tick as the first paint.
  useEffect(() => {
    if (demo) {
      // Demo swaps ENTIRELY to fixtures; no agent call carries a token.
      void import("../../lib/mock").then((m) => {
        setAgents(m.MOCK_AGENTS as unknown as AgentRow[]);
        setDetails(m.MOCK_AGENT_DETAILS as unknown as Record<string, Detail>);
        setTeams([{ id: m.MOCK_TEAM_ORG.id, display_name: m.MOCK_TEAM_ORG.name }]);
        setModels(["Llama-3.1-8B", "Qwen2.5-7B", "Mistral-7B"]);
        setRegionList(["eu-central", "eu-west", "us-east", "us-west"]);
      });
      return;
    }
    if (!authenticated) return;
    const timer = setTimeout(() => {
      void refresh().catch((e) => setErr(errorText(e)));
      void authFetch("/api/team/orgs")
        .then((r) => r.json())
        .then((d) => setTeams(Array.isArray(d.data) ? d.data : []))
        .catch(() => setTeams([]));
      void fetch("/api/gw/v1/models")
        .then((r) => r.json())
        .then((d) => setModels(((d.data ?? []) as { id: string }[]).map((m) => m.id)))
        .catch(() => setModels([]));
      // Regions come from the hosts actually on the network, the same source the team rules use.
      void fetch("/api/gw/api/hosts")
        .then((r) => r.json())
        .then((d) => {
          const seen = new Set<string>();
          for (const h of (d.data ?? []) as { geo?: string; region?: string }[]) {
            if (h.geo) seen.add(h.geo);
            if (h.region) seen.add(h.region);
          }
          setRegionList([...seen].sort());
        })
        .catch(() => setRegionList([]));
    }, 0);
    return () => clearTimeout(timer);
  }, [authenticated, authFetch, refresh, demo]);

  // Load the Ledger kit when a row opens, so a click reaches the browser's device prompt in time.
  useEffect(() => {
    if (openId) void preloadLedgerKit().catch(() => {});
  }, [openId]);

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

  const policyBody = (): Policy => ({
    dailyCredits: numberOrNull(daily),
    monthlyCredits: numberOrNull(monthly),
    lifetimeCredits: numberOrNull(lifetime),
    maxRequestCredits: numberOrNull(maxRequest),
    models: picked.length ? picked : null,
    regions: pickedRegions.length ? pickedRegions : null,
    verifiedOnly,
    requestsPerMinute: numberOrNull(rpm),
    maxConcurrent: numberOrNull(concurrent),
    credentialTtlDays: numberOrNull(ttl),
    exceptions: { credits: exceptions },
  });

  function resetForm() {
    setName("");
    setDescription("");
    setFunding("personal");
    setDaily("100");
    setMonthly("");
    setLifetime("");
    setMaxRequest("");
    setPicked([]);
    setPickedRegions([]);
    setVerifiedOnly(false);
    setRpm("30");
    setConcurrent("2");
    setTtl("90");
    setExceptions(true);
  }

  const createAgent = () =>
    run("create", async () => {
      setSecret(null);
      const r = await authFetch(`${GW}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, ...(funding === "personal" ? {} : { orgId: funding }), policy: policyBody() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      setSecret({ name: d.agent.name, key: d.key });
      resetForm();
      setFormOpen(false);
      await refresh();
      setOpenId(d.agent.id);
    });

  const [deviceStep, setDeviceStep] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<{ agentId: string; message: string; token: string; signature: string } | null>(null);

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

  function startEdit(agent: AgentRow) {
    const p = agent.policy;
    setEditing(agent);
    setFormOpen(true);
    setName(agent.name);
    setDescription(agent.description);
    setFunding(agent.orgId ?? "personal");
    setDaily(p.dailyCredits === null ? "" : String(p.dailyCredits));
    setMonthly(p.monthlyCredits === null ? "" : String(p.monthlyCredits));
    setLifetime(p.lifetimeCredits === null ? "" : String(p.lifetimeCredits));
    setMaxRequest(p.maxRequestCredits === null ? "" : String(p.maxRequestCredits));
    setPicked(p.models ?? []);
    setPickedRegions(p.regions ?? []);
    setVerifiedOnly(p.verifiedOnly);
    setRpm(p.requestsPerMinute === null ? "" : String(p.requestsPerMinute));
    setConcurrent(p.maxConcurrent === null ? "" : String(p.maxConcurrent));
    setTtl(p.credentialTtlDays === null ? "" : String(p.credentialTtlDays));
    setExceptions(p.exceptions.credits);
  }

  // Narrowing a policy needs nothing; widening a Ledger-protected agent needs that device's signature.
  const saveLimits = (agent: AgentRow) =>
    run("save-limits", async () => {
      const policy = policyBody();
      const send = (extra: Record<string, unknown>) =>
        authFetch(`${GW}/agents/${encodeURIComponent(agent.id)}/policy`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policy, expectedRevision: agent.policyRevision, ...extra }),
        });
      let r = await send({});
      let d = await r.json().catch(() => ({}));
      if (r.status === 403 && d?.error?.type === "ledger_required") {
        const cr = await authFetch(`${GW}/agents/${encodeURIComponent(agent.id)}/policy/challenge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policy }),
        });
        const challenge = await cr.json();
        if (!cr.ok) throw new Error(apiError(challenge, cr.status));
        const signature = await withLedger("Read the new limits on the Ledger and approve them", (l) => l.signMessage(challenge.message));
        r = await send({ ledger: { message: challenge.message, token: challenge.token, signature } });
        d = await r.json().catch(() => ({}));
      }
      if (!r.ok) throw new Error(apiError(d, r.status));
      setEditing(null);
      setFormOpen(false);
      resetForm();
      await refresh();
    }).finally(() => setDeviceStep(null));

  const act = (agent: AgentRow, action: "pause" | "resume" | "revoke" | "rotate") =>
    run(`${action}-${agent.id}`, async () => {
      const r = await authFetch(`${GW}/agents/${encodeURIComponent(agent.id)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      if (action === "rotate") setSecret({ name: agent.name, key: d.key });
      await refresh();
    });

  const changeLedger = (agent: AgentRow, action: "enroll" | "replace" | "remove") =>
    run(`ledger-${agent.id}`, async () => {
      const base = `${GW}/agents/${encodeURIComponent(agent.id)}/ledger`;
      const prompt = action === "remove" ? "Approve removing this Ledger on the device" : "Confirm the address on the Ledger, then approve the enrollment message";
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
    await loadDetail(agentId);
    await refresh();
  }

  const teamName = (orgId: string | null) => (orgId ? teams.find((t) => t.id === orgId)?.display_name ?? orgId : "My budget");
  const sourceLabel = (a: AgentRow) => (a.orgId ? `${teamName(a.orgId)} credits` : "My budget");

  // Everything the header counts comes from the details that were just loaded.
  const list = agents ?? [];
  const running = list.filter((a) => a.state === "ready").length;
  const paused = list.filter((a) => a.state === "paused").length;
  const spentToday = list.reduce((sum, a) => sum + (todayOf(details[a.id]?.usage ?? [])?.spent ?? 0), 0);
  const dailyCaps = list.map((a) => a.policy.dailyCredits);
  const cappedTotal = dailyCaps.filter((v): v is number => v !== null).reduce((a, b) => a + b, 0);
  const uncapped = dailyCaps.filter((v) => v === null).length;
  const pendingAll = list.flatMap((a) => (details[a.id]?.approvals ?? []).filter((x) => x.state === "pending").map((x) => ({ ...x, agent: a })));

  const statusOf = (a: AgentRow): keyof typeof STATUS_PILL => {
    if (a.state !== "ready") return a.state;
    const today = todayOf(details[a.id]?.usage ?? []);
    return today && today.limit !== null && today.spent >= today.limit ? "at ceiling" : "ready";
  };

  const readback = (p: { models: string[]; dailyCap: number | null; source: string; exceptions: boolean; team: boolean }) => {
    const m = p.models.length ? p.models.join(" and ") : "any allowed model";
    const cap = p.dailyCap === null ? "with no daily ceiling" : `up to ${fmt(p.dailyCap)} credits a day`;
    const ask = !p.exceptions ? "stops dead at the ceiling" : p.team ? "asks the team owner when it needs more" : "asks for a Ledger tap when it needs more";
    return `Spends ${cap} from ${p.source.toLowerCase()} on ${m}, and ${ask}.`;
  };

  const curl = (key: string) =>
    `curl ${typeof window === "undefined" ? "" : window.location.origin}/api/gw/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Idempotency-Key: task-1" \\\n  -d '{"model":"${picked[0] ?? models[0] ?? "qwen2.5:0.5b"}","messages":[{"role":"user","content":"hello"}]}'`;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-2.5">
        <h1 className="m-0 text-[34px] font-normal tracking-[-0.03em]">Agents</h1>
        <p className="m-0 max-w-[660px] text-[15px] leading-[1.6] text-[#5D5D5D]">
          Every agent gets its own scoped key and its own ceiling. When an agent reaches it the request is refused before any host is paid, and the agent receives an
          approval link — it can ask you for more, it can&apos;t quietly take more.
        </p>
      </div>

      {!ready && !demo ? (
        <div className="h-32 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
      ) : !authenticated && !demo ? (
        <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-12 text-center">
          <p className="m-0 text-sm text-[#6E6E73]">Log in to create and manage agents.</p>
          <LoginButton />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
            <Stat label="Agents running" value={String(running)} note={paused ? `${paused} paused` : "none paused"} />
            <Stat
              label="Spent today"
              value={fmt(spentToday)}
              note={uncapped ? `${uncapped} with no daily ceiling` : `of ${fmt(cappedTotal)} across all ceilings`}
            />
            <Stat
              label="Credit requests"
              value={String(pendingAll.length)}
              tone={pendingAll.length ? "amber" : "plain"}
              note={
                pendingAll.length ? (
                  <Link href={`/approvals/${pendingAll[0].id}`} className="text-[#2563EB] hover:underline">
                    Review {pendingAll[0].agent.name} →
                  </Link>
                ) : (
                  "nothing waiting"
                )
              }
            />
          </div>

          <section className="overflow-hidden rounded-[14px] border border-[#E5E5E0]">
            <div className="flex items-center gap-3 border-b border-[#E5E5E0] px-6 py-[18px]">
              <span className="text-[17px] font-medium">{editing ? `Limits for ${editing.name}` : "New agent"}</span>
              <span className="text-[13px] text-[#5D5D5D]">{editing ? "Narrowing applies at once; widening a protected agent needs its Ledger." : "Four decisions, then a key."}</span>
              <button
                type="button"
                onClick={() => {
                  if (editing) {
                    setEditing(null);
                    resetForm();
                    setFormOpen(false);
                    return;
                  }
                  setFormOpen((o) => !o);
                }}
                className="ml-auto h-[30px] shrink-0 rounded-full border border-[#E5E5E0] bg-white px-3.5 text-[13px] text-[#424242] transition-colors hover:bg-[#F4F4F4]"
              >
                {editing ? "Cancel" : formOpen ? "Hide" : "New agent"}
              </button>
            </div>

            {formOpen && (
              <div className="flex flex-col gap-7 p-6">
                {!editing && (
                  <>
                    <Row title="Identity" note="Shows on every receipt this agent signs.">
                      <div className="flex flex-col gap-2.5">
                        <input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="nightly-evals"
                          aria-label="Agent name"
                          className="h-[42px] rounded-xl border border-[#E5E5E0] bg-white px-3.5 text-[15px] outline-none focus:border-black/40"
                        />
                        <input
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="What it does — optional"
                          aria-label="Description"
                          className="h-[42px] rounded-xl border border-[#E5E5E0] bg-white px-3.5 text-sm outline-none focus:border-black/40"
                        />
                      </div>
                    </Row>
                    <div className="h-px bg-[#F4F4F4]" />
                  </>
                )}

                <Row title="Money" note="Where it spends from, and how much it may ever spend.">
                  <div className="flex flex-col gap-4">
                    {!editing && (
                      <div className="grid gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(210px,1fr))]">
                        {[{ id: "personal", label: "My budget", note: "Spends your personal credits — invisible to any team." }, ...teams.map((t) => ({ id: t.id, label: `${t.display_name} credits`, note: "Spends the team treasury inside your own seat allowance." }))].map((s) => {
                          const on = funding === s.id;
                          return (
                            <button
                              key={s.id}
                              type="button"
                              aria-pressed={on}
                              onClick={() => setFunding(s.id)}
                              className={`${cardBtn} ${on ? "border-[#0D0D0D] bg-[#0D0D0D]" : "border-[#E5E5E0] bg-white hover:bg-[#FBFBFA]"}`}
                            >
                              <span className={`text-sm font-medium ${on ? "text-white" : ""}`}>{s.label}</span>
                              <span className={`text-[12px] leading-[1.5] ${on ? "text-[#C9C9C9]" : "text-[#5D5D5D]"}`}>{s.note}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(148px,1fr))]">
                      <Field label="Credits per UTC day" value={daily} onChange={setDaily} unit="cr" />
                      <Field label="Credits per month" value={monthly} onChange={setMonthly} unit="cr" />
                      <Field label="Lifetime ceiling" value={lifetime} onChange={setLifetime} unit="cr" />
                      <Field label="Max per request" value={maxRequest} onChange={setMaxRequest} unit="cr" />
                    </div>
                  </div>
                </Row>

                <div className="h-px bg-[#F4F4F4]" />

                <Row title="Guardrails" note="Narrower than the team's firm rules, never wider.">
                  <div className="flex flex-col gap-[18px]">
                    <div className="flex flex-col gap-2.5">
                      <span className="text-[12px] text-[#5D5D5D]">
                        {picked.length ? `Models it may call — ${picked.length} selected.` : "No model selected, so everything the team allows is routable."}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {models.map((m) => {
                          const on = picked.includes(m);
                          return (
                            <button
                              key={m}
                              type="button"
                              aria-pressed={on}
                              onClick={() => setPicked((p) => (on ? p.filter((x) => x !== m) : [...p, m]))}
                              className={`${pill} ${on ? "border-[#0D0D0D] bg-[#0D0D0D] text-white" : "border-[#E5E5E0] bg-white text-[#424242] hover:bg-[#F4F4F4]"}`}
                            >
                              {on && <Glyph size={13} d={CHECK_ICON} />}
                              {m}
                            </button>
                          );
                        })}
                        {models.length === 0 && <span className="font-mono text-[11px] text-[#8F8F8F]">loading models…</span>}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2.5">
                      <span className="text-[12px] text-[#5D5D5D]">
                        {pickedRegions.length
                          ? `Regions it may be served from — ${pickedRegions.length} selected.`
                          : "No region selected, so any region the team allows can serve it."}
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {regionList.map((r) => {
                          const on = pickedRegions.includes(r);
                          return (
                            <button
                              key={r}
                              type="button"
                              aria-pressed={on}
                              onClick={() => setPickedRegions((p) => (on ? p.filter((x) => x !== r) : [...p, r]))}
                              className={`${pill} ${on ? "border-[#0D0D0D] bg-[#0D0D0D] text-white" : "border-[#E5E5E0] bg-white text-[#424242] hover:bg-[#F4F4F4]"}`}
                            >
                              {on && <Glyph size={13} d={CHECK_ICON} />}
                              {r}
                            </button>
                          );
                        })}
                        {regionList.length === 0 && <span className="font-mono text-[11px] text-[#8F8F8F]">no host reports a region yet</span>}
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(148px,1fr))]">
                      <Field label="Requests per minute" value={rpm} onChange={setRpm} unit="req" />
                      <Field label="Concurrent requests" value={concurrent} onChange={setConcurrent} unit="calls" />
                      <Field label="Key expiry" value={ttl} onChange={setTtl} unit="days" placeholder="never" />
                    </div>
                    <div className="flex items-center gap-3.5 rounded-xl border border-[#E5E5E0] p-[13px_16px]">
                      <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[#F4F4F4] text-[#0D0D0D]">
                        <Glyph d={SHIELD_ICON} />
                      </span>
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm">Verified hosts only</span>
                        <span className="text-[12px] text-[#5D5D5D]">Excludes hosts that failed a spot-check, even when they&apos;re cheapest.</span>
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={verifiedOnly}
                        aria-label="Verified hosts only"
                        onClick={() => setVerifiedOnly((v) => !v)}
                        className={`relative ml-auto h-6 w-[42px] shrink-0 rounded-full transition-colors ${verifiedOnly ? "bg-[#0D0D0D]" : "bg-[#CDCDCD]"}`}
                      >
                        <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all ${verifiedOnly ? "left-[21px]" : "left-[3px]"}`} />
                      </button>
                    </div>
                  </div>
                </Row>

                <div className="h-px bg-[#F4F4F4]" />

                <Row title="At the ceiling" note="What happens when it runs out of credits mid-task.">
                  <div className="grid gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
                    {[
                      funding === "personal"
                        ? { on: exceptions, icon: LEDGER_ICON, label: "Ask my Ledger", note: "Raising the ceiling needs a tap on the enrolled device.", pick: () => setExceptions(true) }
                        : { on: exceptions, icon: OWNER_ICON, label: "Ask the owner", note: "The agent gets an approval link; the team owner decides.", pick: () => setExceptions(true) },
                      { on: !exceptions, icon: STOP_ICON, label: "Hard stop", note: "No approvals. Calls are refused until you raise it yourself.", pick: () => setExceptions(false) },
                    ].map((m) => (
                      <button key={m.label} type="button" aria-pressed={m.on} onClick={m.pick} className={`${cardBtn} ${m.on ? "border-[#0D0D0D] bg-[#0D0D0D]" : "border-[#E5E5E0] bg-white hover:bg-[#FBFBFA]"}`}>
                        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${m.on ? "bg-[#242424] text-white" : "bg-[#F4F4F4] text-[#0D0D0D]"}`}>
                          <Glyph d={m.icon} />
                        </span>
                        <span className={`text-sm font-medium ${m.on ? "text-white" : ""}`}>{m.label}</span>
                        <span className={`text-[12px] leading-[1.5] ${m.on ? "text-[#C9C9C9]" : "text-[#5D5D5D]"}`}>{m.note}</span>
                      </button>
                    ))}
                  </div>
                </Row>

                <div className="flex flex-wrap items-center gap-[18px] rounded-xl bg-[#F7F7F5] p-5">
                  <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
                    <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Policy, in words</span>
                    <span className="text-pretty text-sm leading-[1.6]">
                      {readback({ models: picked, dailyCap: numberOrNull(daily), source: editing ? sourceLabel(editing) : funding === "personal" ? "My budget" : `${teamName(funding)} credits`, exceptions, team: funding !== "personal" })}
                    </span>
                  </div>
                  {deviceStep && <span className="font-mono text-[11px] text-[#5D5D5D]">{deviceStep}</span>}
                  <button
                    type="button"
                    onClick={() => (editing ? saveLimits(editing) : createAgent())}
                    disabled={!!busy || (!editing && !name.trim())}
                    className="h-11 shrink-0 rounded-full bg-[#0D0D0D] px-[22px] text-[15px] font-medium text-white transition-colors hover:bg-[#2F2F2F] disabled:border disabled:border-[#E5E5E0] disabled:bg-white disabled:text-[#8F8F8F]"
                  >
                    {busy === "create" ? "creating…" : busy === "save-limits" ? "saving…" : editing ? "Save limits" : "Create agent"}
                  </button>
                </div>
              </div>
            )}
          </section>

          {secret && (
            <section ref={keyCard} className="flex flex-col gap-4 rounded-[14px] border border-[#F2E1C4] bg-[#FDF3E2] p-[22px]">
              <div className="flex items-center gap-2.5">
                <span className="text-[#8A5300]">
                  <Glyph size={17} d={KEY_ICON} />
                </span>
                <span className="text-[15px] font-medium text-[#8A5300]">Key for {secret.name} — shown once</span>
                <button type="button" onClick={() => setSecret(null)} className="ml-auto h-7 rounded-full px-3 text-[12px] text-[#8A5300] hover:bg-black/5">
                  Done
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 rounded-[10px] bg-white p-[12px_14px]">
                <span className="min-w-[240px] flex-1 overflow-hidden text-ellipsis font-mono text-[13px]">{secret.key}</span>
                <CopyButton text={secret.key} label="Copy key" />
              </div>
              <div className="overflow-hidden rounded-[10px] bg-[#0D0D0D]">
                <div className="flex items-center justify-between gap-3 border-b border-[#232323] px-3.5 py-2.5">
                  <span className="font-mono text-[11px] text-[#8F8F8F]">first call</span>
                  <CopyButton text={curl(secret.key)} label="Copy command" dark />
                </div>
                <pre className="m-0 overflow-x-auto p-3.5 font-mono text-[12px] leading-[1.7] text-[#E6E6E6]">{curl(secret.key)}</pre>
              </div>
              <p className="m-0 text-[12px] leading-[1.6] text-[#8A5300]">
                Past the ceiling the gateway answers <span className="font-mono">403 approval_required</span> with an approval URL. Poll it with the same key, then retry the
                original request with the same Idempotency-Key.
              </p>
            </section>
          )}

          <section className="flex flex-col gap-3.5">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="m-0 text-[19px] font-medium tracking-[-0.02em]">Your agents</h2>
              <span className="font-mono text-[12px] tabular-nums text-[#5D5D5D]">
                {agents === null ? "…" : `${list.length} agent${list.length === 1 ? "" : "s"}`}
              </span>
            </div>

            {agents !== null && list.length === 0 && <p className="m-0 text-sm text-[#8F8F8F]">No agents yet.</p>}

            {list.map((a) => {
              const detail = details[a.id];
              const today = todayOf(detail?.usage ?? []);
              const status = statusOf(a);
              const tone = STATUS_PILL[status];
              const ratio = today && today.limit ? today.spent / today.limit : 0;
              const open = openId === a.id;
              const atCap = !!today && today.limit !== null && today.spent >= today.limit;
              const pending = (detail?.approvals ?? []).filter((x) => x.state === "pending");
              return (
                <div key={a.id} className={`overflow-x-auto rounded-[14px] border ${atCap && a.state === "ready" ? "border-[#F2E1C4]" : "border-[#E5E5E0]"}`}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : a.id)}
                    className="grid w-full min-w-[700px] cursor-pointer grid-cols-[34px_minmax(130px,1fr)_auto_auto_176px_15px] items-center gap-3.5 px-5 py-[18px] text-left transition-colors hover:bg-[#FBFBFA]"
                  >
                    <span className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[#F4F4F4] text-[#0D0D0D]">
                      <Glyph size={16} d={CHIP_ICON} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-base font-medium">{a.name}</span>
                      <span className="font-mono text-[11px] text-[#5D5D5D]">{a.id}</span>
                    </span>
                    <span className={`inline-flex h-6 items-center gap-1.5 justify-self-start whitespace-nowrap rounded-full px-2.5 text-[11px] ${tone.bg} ${tone.fg}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${tone.pulse ? "animate-pulse" : ""}`} />
                      {status}
                    </span>
                    <span className="inline-flex h-6 items-center justify-self-start whitespace-nowrap rounded-full bg-[#F4F4F4] px-2.5 text-[11px] text-[#424242]">{sourceLabel(a)}</span>
                    <span className="flex min-w-0 flex-col gap-1.5">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={`font-mono text-[12px] tabular-nums ${atCap ? "text-[#B3261E]" : ""}`}>
                          {today ? `${fmt(today.spent)}${today.limit === null ? " cr" : ` / ${fmt(today.limit)}`}` : "—"}
                        </span>
                        <span className="text-[11px] text-[#5D5D5D]">today</span>
                      </span>
                      <span className="h-[5px] overflow-hidden rounded-full bg-[#F0F0EE]">
                        <span
                          className={`block h-full rounded-full ${today?.limit == null ? "bg-[#CDCDCD]" : ratio >= 1 ? "bg-[#DC2626]" : ratio >= 0.85 ? "bg-[#D97706]" : "bg-[#0D0D0D]"}`}
                          style={{ width: today?.limit == null ? "100%" : `${Math.min(100, Math.round(ratio * 100))}%` }}
                        />
                      </span>
                    </span>
                    <span className={`inline-flex text-[#8F8F8F] transition-transform ${open ? "rotate-180" : ""}`}>
                      <Glyph d={<path d="m6 9 6 6 6-6" />} />
                    </span>
                  </button>

                  {open && detail && (
                    <div className="flex min-w-[700px] flex-col gap-5 border-t border-[#F4F4F4] p-5">
                      <div className="grid gap-3.5 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
                        {detail.usage.map((u) => (
                          <div key={u.period} className="flex flex-col gap-1.5 rounded-xl bg-[#F7F7F5] p-4">
                            <span className="text-[11px] text-[#5D5D5D]">{periodLabel(u.period)}</span>
                            <span className="font-mono text-[19px] tracking-[-0.02em] tabular-nums">
                              {fmt(u.spent)}
                              {u.limit === null ? "" : ` / ${fmt(u.limit)}`}
                            </span>
                            <span className="font-mono text-[11px] tabular-nums text-[#5D5D5D]">
                              {u.reserved} reserved · {u.remaining === null ? "no cap" : `${fmt(u.remaining)} left`}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-col gap-2.5">
                        <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Policy</span>
                        <p className="m-0 max-w-[640px] text-sm leading-[1.6]">
                          {readback({ models: a.policy.models ?? [], dailyCap: a.policy.dailyCredits, source: sourceLabel(a), exceptions: a.policy.exceptions.credits, team: !!a.orgId })}
                        </p>
                        <div className="flex flex-wrap gap-2 pt-0.5">
                          {[
                            `${a.policy.requestsPerMinute ?? "no"} req/min`,
                            `${a.policy.maxConcurrent ?? "no"} concurrent`,
                            a.policy.maxRequestCredits === null ? "no per-request cap" : `${fmt(a.policy.maxRequestCredits)} cr/req cap`,
                            a.policy.regions === null ? "any region" : `regions ${a.policy.regions.join(", ")}`,
                            ...(a.policy.verifiedOnly ? ["verified hosts only"] : []),
                            `sponsor ${teamName(a.orgId)}`,
                            `policy revision ${a.policyRevision}`,
                            ...(detail.effective.memberAllowance !== undefined ? [`allowance ${detail.effective.memberAllowance === null ? "unlimited" : `${fmt(detail.effective.memberAllowance)}/mo`}`] : []),
                          ].map((t) => (
                            <span key={t} className="inline-flex h-6 items-center rounded-full border border-[#E5E5E0] px-2.5 font-mono text-[11px] text-[#424242]">
                              {t}
                            </span>
                          ))}
                        </div>
                        {detail.effective.sponsorActive === false && <span className="text-[12px] text-[#B3261E]">The sponsoring member is no longer active.</span>}
                      </div>

                      {pending.length > 0 && (
                        <div className="flex flex-col gap-2 rounded-xl border border-[#F2E1C4] bg-[#FDF3E2] p-4">
                          {pending.map((ap) => (
                            <Link key={ap.id} href={`/approvals/${ap.id}`} className="flex flex-wrap items-center gap-x-3 text-[13px] text-[#8A5300] hover:underline">
                              <span>Asking for +{fmt(ap.additionalCredits)} credits</span>
                              <span className="font-mono text-[11px]">{ap.limits.map((l) => l.label).join(", ")}</span>
                              <span className="ml-auto underline">Review →</span>
                            </Link>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-[#E5E5E0] p-4">
                        <span className={`inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] ${a.ledgerAddress ? "bg-[#E7F5EE] text-[#0B7A5D]" : "bg-[#F4F4F4] text-[#0D0D0D]"}`}>
                          <Glyph d={LEDGER_ICON} />
                        </span>
                        <span className="flex min-w-[200px] flex-col gap-0.5">
                          <span className="text-sm">{a.ledgerAddress ? "Ledger approvals are on" : "No Ledger enrolled"}</span>
                          <span className="font-mono text-[12px] text-[#5D5D5D]">
                            {a.ledgerAddress ? `${a.ledgerAddress.slice(0, 10)}… · tap needed to raise the ceiling` : a.orgId ? `ceiling increases go to ${teamName(a.orgId)}` : "enrol to approve its own increases"}
                          </span>
                        </span>
                        {a.state !== "revoked" && (
                          <span className="ml-auto flex flex-wrap gap-2">
                            {!a.ledgerAddress ? (
                              <button type="button" onClick={() => changeLedger(a, "enroll")} disabled={!!busy} className={ghost}>
                                Enrol a Ledger
                              </button>
                            ) : (
                              <>
                                <button type="button" onClick={() => changeLedger(a, "replace")} disabled={!!busy} className={ghost}>
                                  Replace device
                                </button>
                                <button type="button" onClick={() => changeLedger(a, "remove")} disabled={!!busy} className={ghost}>
                                  Remove
                                </button>
                                {replacement?.agentId === a.id && (
                                  <button type="button" onClick={() => confirmReplacement(a)} disabled={!!busy} className="h-[34px] rounded-full bg-[#0D0D0D] px-3.5 text-[13px] text-white disabled:opacity-40">
                                    Approve with the current Ledger
                                  </button>
                                )}
                              </>
                            )}
                          </span>
                        )}
                        {deviceStep && <span className="w-full font-mono text-[11px] text-[#5D5D5D]">{deviceStep}</span>}
                      </div>

                      <div className="flex flex-col gap-2.5">
                        <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Keys</span>
                        {detail.credentials.map((c) => {
                          const state = c.revokedAt ? "revoked" : c.expiresAt && c.expiresAt < Date.now() ? "expired" : "active";
                          return (
                            <div key={c.id} className="flex items-center gap-3 border-b border-[#F4F4F4] py-2.5 last:border-b-0">
                              <span className="font-mono text-[12px]">{c.prefix}…</span>
                              <span className={`inline-flex h-[22px] items-center rounded-full px-2.5 text-[11px] ${state === "active" ? "bg-[#E7F5EE] text-[#0B7A5D]" : "bg-[#FDECEA] text-[#B3261E]"}`}>{state}</span>
                              <span className="ml-auto font-mono text-[11px] tabular-nums text-[#5D5D5D]">
                                {c.revokedAt ? `rotated ${new Date(c.revokedAt).toISOString().slice(0, 10)}` : c.expiresAt ? `expires ${new Date(c.expiresAt).toISOString().slice(0, 10)}` : "no expiry"}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {!a.orgId && a.budgetAddress && (
                        <AgentFunding key={a.id} agentId={a.id} ledgerAddress={a.ledgerAddress} ledgerSign={(prompt, message) => withLedger(prompt, (l) => l.signMessage(message))} />
                      )}

                      {a.state !== "revoked" && (
                        <div className="flex flex-wrap items-center gap-2">
                          <button type="button" onClick={() => act(a, a.state === "paused" ? "resume" : "pause")} disabled={!!busy} className={`${ghost} w-[92px]`}>
                            {a.state === "paused" ? "Resume" : "Pause"}
                          </button>
                          <button type="button" onClick={() => act(a, "rotate")} disabled={!!busy} className={`${ghost} w-[92px]`}>
                            Rotate key
                          </button>
                          <button type="button" onClick={() => startEdit(a)} disabled={!!busy} className={`${ghost} w-[92px]`}>
                            Edit limits
                          </button>
                          <button
                            type="button"
                            onClick={() => act(a, "revoke")}
                            disabled={!!busy}
                            className="ml-auto h-[34px] w-[92px] rounded-full border border-[#E5E5E0] bg-white text-[13px] text-[#B3261E] transition-colors hover:bg-[#FDECEA] disabled:opacity-40"
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}

          <p className="m-0 text-[12px] leading-[1.7] text-[#5D5D5D]">
            An agent&apos;s key carries no authority of its own — it authorises payments against this policy, so revoking it or lowering a ceiling takes effect on the next call.
          </p>
        </>
      )}
    </div>
  );
}
