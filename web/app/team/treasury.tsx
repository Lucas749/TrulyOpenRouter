"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuthorizationSignature, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, formatEther, parseEther } from "viem";
import { apiError } from "../../lib/api-error";
import { accountUrl, txUrl } from "../../lib/chain";
import { hederaTestnet } from "../../lib/hedera-chains";
import { friendlyTxError } from "../../lib/tx-errors";
import { useAuthFetch } from "../components/use-auth-fetch";

// Compute Treasury: the Privy organization wallet behind a team's shared compute
// credits. Deposits come from your own wallet. Purchases, refunds, payouts, and
// limit changes are Privy intents: an owner or manager proposes exact terms, the
// financial approver signs them in this browser, the broker key co-signs, and the
// gateway broadcasts and confirms on Hedera testnet.

interface Intent {
  id: string;
  kind: "buy_credits" | "refund" | "payout_hbar" | "payout_usdc" | "update_policy";
  state: string;
  terms: Record<string, string>;
  transactionHash: string | null;
  result: Record<string, string>;
  error: string | null;
  approvals: { by: string; method: string; at: number }[];
  createdAt: number;
}

interface Plan {
  planId: string;
  priceTinybar: string;
  credits: string;
  allowed: boolean;
}

interface TreasuryView {
  network: string;
  team: { walletAddress: string | null; state: string; approverUserId: string | null; payoutRecipients: string[] } | null;
  balances: { hbarWei: string | null; credits: string | null; testUsdcUnits: string | null };
  plans: Plan[];
  limits: { planIds: string[]; hbarPayoutCap: string; usdcPayoutCap: string; recipients: string[] } | null;
  intents: Intent[];
  me: { role: string; financialApprover: boolean };
}

type Tab = "deposit" | "buy" | "payout" | "limits";

const OPEN_STATES = ["proposed", "awaiting_approvals", "authorized", "signed", "submitted", "uncertain"];
const MOVING_STATES = ["proposed", "authorized", "signed", "submitted"];
// Room for network fees on top of a plan price; onboarding asks 10.5 HBAR for the 10 HBAR plan.
const FEE_ROOM_HBAR = 0.5;

const WAITING = "bg-[#FDF3E2] text-[#8A5300]";
const GOOD = "bg-[#E7F5EE] text-[#0B7A5D]";
const BAD = "bg-[#FDECEA] text-[#B3261E]";
const STATUS: Record<string, [string, string]> = {
  proposed: ["preparing", WAITING],
  awaiting_approvals: ["needs approval", WAITING],
  authorized: ["approved", WAITING],
  signed: ["sending", WAITING],
  submitted: ["sending", WAITING],
  confirmed: ["confirmed", GOOD],
  denied: ["rejected", BAD],
  expired: ["expired", BAD],
  reverted: ["reverted", BAD],
  cancelled: ["cancelled", BAD],
  uncertain: ["check status", WAITING],
  failed: ["failed", BAD],
};

const primary =
  "flex h-9 shrink-0 items-center justify-center rounded-full bg-[#0D0D0D] px-4 text-[13px] text-white transition-colors hover:bg-zinc-800 disabled:bg-[#D4D4CF]";
const secondary =
  "flex h-9 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white px-4 text-[13px] text-[#0D0D0D] transition-colors hover:bg-[#F7F7F5] disabled:opacity-40";
const field =
  "h-9 w-full rounded-full border border-black/10 bg-white pl-3.5 font-mono text-[13px] text-[#0D0D0D] outline-none transition-colors focus:border-black/40";

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hbarNumber = (wei: string | null) => (wei === null ? null : Number(formatEther(BigInt(wei))));
const hbarOf = (wei: string | null) => hbarNumber(wei)?.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? "—";
const usdcOf = (units: string | null) => (units === null ? "—" : (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 }));
const count = (n: string | null | undefined) => (n ? Number(n).toLocaleString("en-US") : "—");
const planPrice = (p: Plan) => Number(p.priceTinybar) / 1e8;
const planName = (p: Plan) => `${count(p.credits)} credits`;

function planNames(ids: string, plans: Plan[]): string {
  const names = ids
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => {
      const p = plans.find((x) => x.planId === id);
      return p ? `${planName(p)} for ${planPrice(p)} HBAR` : `plan ${id}`;
    });
  return names.length ? names.join(", ") : "none";
}

function headline(i: Intent): string {
  const t = i.terms;
  const to = t.recipient ? ` to ${shortAddress(t.recipient)}` : "";
  if (i.kind === "buy_credits") return `Buy ${count(t.credits)} credits for ${t.priceHbar} HBAR`;
  if (i.kind === "refund") return `Refund ${count(t.credits)} unused credits`;
  if (i.kind === "payout_hbar") return `Pay out ${t.amount} HBAR${to}`;
  if (i.kind === "payout_usdc") return `Pay out ${t.amount} test USDC${to}`;
  return "Change wallet limits";
}

function progress(i: Intent, approver: boolean): string {
  if (i.state === "awaiting_approvals") return approver ? "Waiting for your approval" : "Waiting for the financial approver";
  if (i.state === "proposed") return "Preparing";
  if (i.state === "authorized") return i.kind === "update_policy" ? "Approved, updating the wallet policy" : "Approved, signing";
  if (i.state === "uncertain") return "Status unclear, check it to finish";
  return "Sending to Hedera";
}

function ago(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 overflow-x-auto rounded-full bg-[#F2F2EF] p-1">
      {options.map(([id, text]) => (
        <button
          key={id}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={`h-8 flex-1 whitespace-nowrap rounded-full px-2 text-[13px] transition-colors sm:px-3.5 ${
            value === id ? "bg-white text-[#0D0D0D] shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-[#6E6E73] hover:text-[#0D0D0D]"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Amount({ value, onChange, unit, label, className = "w-full sm:w-40" }: { value: string; onChange: (v: string) => void; unit: string; label: string; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" placeholder="0" aria-label={label} className={`${field} pr-14`} />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] text-[#8F8F8F]">{unit}</span>
    </div>
  );
}

function PanelTitle({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px] font-medium">{title}</span>
        <span className="text-[13px] text-[#6E6E73]">{hint}</span>
      </div>
      {children}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-[#F7F7F5] px-3 py-2.5">
      <dt className="text-[12px] text-[#6E6E73]">{label}</dt>
      <dd className="m-0 text-[13px]">{children}</dd>
    </div>
  );
}

function Terms({ intent, plans }: { intent: Intent; plans: Plan[] }) {
  const t = intent.terms;
  const rows: [string, ReactNode][] = [];
  if (t.credits) rows.push([intent.kind === "refund" ? "Credits refunded" : "Credits", count(t.credits)]);
  if (t.priceHbar) rows.push(["Price", `${t.priceHbar} HBAR`]);
  if (t.amount) rows.push(["Amount", `${t.amount} ${intent.kind === "payout_usdc" ? "test USDC" : "HBAR"}`]);
  if (t.recipient) rows.push([intent.kind === "refund" ? "Refund to" : "To", t.recipient]);
  if (t.plans !== undefined) rows.push(["Credit plans", planNames(t.plans, plans)]);
  if (t.hbarPayoutCap) rows.push(["Largest HBAR payout", `${t.hbarPayoutCap} HBAR`]);
  if (t.usdcPayoutCap) rows.push(["Largest test USDC payout", `${t.usdcPayoutCap} test USDC`]);
  if (t.recipients !== undefined) rows.push(["Recipients", t.recipients || "none"]);
  if (t.previous) rows.push(["Before", t.previous.replace(/^plans ([\d, ]*)/, (_, ids: string) => `${planNames(ids, plans)} `)]);
  if (t.vault) rows.push(["Vault", t.vault]);
  if (t.maxFeeHbar) rows.push(["Network fee up to", `${t.maxFeeHbar} HBAR`]);
  if (t.nonce) rows.push(["Nonce", t.nonce]);
  if (t.network) rows.push(["Network", t.network]);
  if (intent.approvals.length) rows.push(["Signed by", intent.approvals.map((a) => (a.method === "privy_user" ? "financial approver" : "broker key")).join(" + ")]);
  if (intent.transactionHash) {
    rows.push([
      "Transaction",
      <a key="tx" href={txUrl(intent.transactionHash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        View on HashScan ↗
      </a>,
    ]);
  }
  return (
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[#8F8F8F]">{k}</dt>
          <dd className="m-0 break-all font-mono text-[#3A3A3C]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function TeamTreasury({ orgId, mock }: { orgId: string; mock: boolean }) {
  const authFetch = useAuthFetch();
  const { wallets } = useWallets();
  const { generateAuthorizationSignature } = useAuthorizationSignature();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TreasuryView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("deposit");
  const [deposit, setDeposit] = useState("11");
  const [payoutAsset, setPayoutAsset] = useState<"payout_hbar" | "payout_usdc">("payout_hbar");
  const [payoutRecipient, setPayoutRecipient] = useState("");
  const [payoutAmount, setPayoutAmount] = useState("");
  const [editing, setEditing] = useState(false);
  const [limitPlans, setLimitPlans] = useState<string[]>([]);
  const [limitHbar, setLimitHbar] = useState("");
  const [limitUsdc, setLimitUsdc] = useState("");
  const [limitRecipients, setLimitRecipients] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const firstLoad = useRef(true);
  const base = `/api/gw/api/team/orgs/${encodeURIComponent(orgId)}`;

  const load = useCallback(async () => {
    if (mock) return;
    try {
      const r = await authFetch(`${base}/treasury`);
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      setView(d);
      if (firstLoad.current) {
        // First look: open straight to a pending approval and start on the step the balance calls for.
        firstLoad.current = false;
        const view = d as TreasuryView;
        const cheapest = view.plans.filter((p) => p.allowed).sort((a, b) => planPrice(a) - planPrice(b))[0];
        const shortfall = cheapest ? planPrice(cheapest) + FEE_ROOM_HBAR - (hbarNumber(view.balances.hbarWei) ?? 0) : 0;
        setDeposit(String(Math.max(1, Math.ceil(shortfall))));
        if ((view.me.role === "owner" || view.me.role === "manager") && shortfall <= 0) setTab("buy");
        if (view.me.financialApprover && view.intents.some((i) => i.state === "awaiting_approvals")) setOpen(true);
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 200));
    }
  }, [authFetch, base, mock]);

  // Load once mounted so the header can show balances and a pending approval while collapsed.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Keep a transaction that is signing or broadcasting current without a manual refresh.
  const moving = !!view?.intents.some((i) => MOVING_STATES.includes(i.state));
  useEffect(() => {
    if (!open || !moving) return;
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [open, moving, load]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void load();
  }

  async function post(tag: string, path: string, body: Record<string, unknown> = {}) {
    setBusy(tag);
    setErr(null);
    setNotice(null);
    try {
      const r = await authFetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(d, r.status));
      return true;
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 240));
      return false;
    } finally {
      setBusy(null);
      await load();
    }
  }

  // The approver signs Privy's exact request bytes in this browser session (Privy's user signer);
  // the gateway submits that signature, then co-signs with the broker key.
  async function approve(id: string) {
    const send = (body: Record<string, unknown>) =>
      authFetch(`${base}/intents/${id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(`approve-${id}`);
    setErr(null);
    setNotice(null);
    try {
      let r = await send({});
      let d = await r.json().catch(() => ({}));
      const challenge = d?.error?.authorization as { payload: string; timestamp: number } | undefined;
      if (r.status === 428 && challenge) {
        const { signature } = await generateAuthorizationSignature(Uint8Array.from(atob(challenge.payload), (c) => c.charCodeAt(0)));
        r = await send({ signature, timestamp: challenge.timestamp });
        d = await r.json().catch(() => ({}));
      }
      if (!r.ok) throw new Error(apiError(d, r.status));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 240));
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function depositFromMyWallet() {
    const wallet = wallets[0];
    const to = view?.team?.walletAddress;
    if (!wallet || !to) {
      setErr("Connect a wallet to deposit, or send HBAR to the team address.");
      return;
    }
    setBusy("deposit");
    setErr(null);
    setNotice(null);
    try {
      await wallet.switchChain(hederaTestnet.id);
      const provider = await wallet.getEthereumProvider();
      const client = createWalletClient({ account: wallet.address as `0x${string}`, chain: hederaTestnet, transport: custom(provider) });
      await client.sendTransaction({ to: to as `0x${string}`, value: parseEther(deposit) });
      setNotice(`Sent ${deposit} HBAR. The balance updates in a few seconds.`);
      setTimeout(() => void load(), 6000);
    } catch (e) {
      setErr(`Deposit failed: ${friendlyTxError(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function editLimits() {
    if (!view?.limits) return;
    setLimitPlans(view.limits.planIds);
    setLimitHbar(view.limits.hbarPayoutCap);
    setLimitUsdc(view.limits.usdcPayoutCap);
    setLimitRecipients(view.limits.recipients.join("\n"));
    setTab("limits");
    setEditing(true);
  }

  function copyAddress(address: string) {
    (navigator.clipboard?.writeText(address) ?? Promise.reject()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }

  const team = view?.team;
  const walletAddress = team?.walletAddress ?? "";
  const canPropose = view?.me.role === "owner" || view?.me.role === "manager";
  const isOwner = view?.me.role === "owner";
  const approver = !!view?.me.financialApprover;
  const intents = [...(view?.intents ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const openIntent = intents.find((i) => OPEN_STATES.includes(i.state));
  const history = intents.filter((i) => i !== openIntent);
  const hbar = hbarNumber(view?.balances.hbarWei ?? null);
  const plans = view?.plans ?? [];
  const allowedPlans = plans.filter((p) => p.allowed);
  const cheapest = [...allowedPlans].sort((a, b) => planPrice(a) - planPrice(b))[0];
  const shortfall = cheapest && hbar !== null ? planPrice(cheapest) + FEE_ROOM_HBAR - hbar : 0;
  const recipients = team?.payoutRecipients ?? [];
  const recipient = recipients.includes(payoutRecipient) ? payoutRecipient : (recipients[0] ?? "");
  const payoutUnit = payoutAsset === "payout_hbar" ? "HBAR" : "USDC";
  const payoutCap = payoutAsset === "payout_hbar" ? view?.limits?.hbarPayoutCap : view?.limits?.usdcPayoutCap;
  const tabs: [Tab, string][] = canPropose
    ? [["deposit", "Deposit"], ["buy", "Buy credits"], ["payout", "Pay out"], ["limits", "Limits"]]
    : [["deposit", "Deposit"], ["limits", "Limits"]];
  const activeTab = tabs.some(([id]) => id === tab) ? tab : "deposit";
  const active = !!walletAddress && team?.state === "active";
  const waiting = intents.some((i) => i.state === "awaiting_approvals");
  const busyNote = openIntent && <span className="text-[12px] text-[#8A5300]">Finish the pending transaction above first.</span>;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#E5E5E0] px-4 py-3">
      <button onClick={toggle} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-left">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Compute Treasury</span>
        {waiting && (
          <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] ${WAITING}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-[#D08A00]" />
            {approver ? "needs your approval" : "awaiting approval"}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">
          {view && active ? `${count(view.balances.credits)} credits · ${hbarOf(view.balances.hbarWei)} HBAR` : ""}
        </span>
        <span className={`font-mono text-xs text-[#8F8F8F] transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && !mock && (
        <div className="flex flex-col gap-4 pb-1 pt-1">
          {err && (
            <div role="alert" className={`flex items-start gap-3 rounded-[14px] px-4 py-3 text-[13px] ${BAD}`}>
              <span className="min-w-0 flex-1 break-words">{err}</span>
              <button onClick={() => setErr(null)} aria-label="Dismiss" className="leading-none opacity-60 hover:opacity-100">
                ×
              </button>
            </div>
          )}
          {notice && <div className={`rounded-[14px] px-4 py-3 text-[13px] ${GOOD}`}>{notice}</div>}

          {!view ? (
            !err && <div className="h-40 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
          ) : !active ? (
            <p className="m-0 text-sm text-[#6E6E73]">This team has no Compute Treasury wallet. Teams created before team wallets need to be recreated.</p>
          ) : (
            <>
              {openIntent && (
                <div className="flex flex-col gap-3 rounded-[14px] border border-[#F0DDB5] bg-[#FDF8EE] p-4">
                  <span className="flex items-center gap-2 text-[12px] font-medium text-[#8A5300]">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-[#D08A00]" />
                    {progress(openIntent, approver)}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[17px] font-medium">{headline(openIntent)}</span>
                    <span className="text-[13px] text-[#6E6E73]">
                      {openIntent.kind === "update_policy"
                        ? `${planNames(openIntent.terms.plans ?? "", plans)} · payouts up to ${openIntent.terms.hbarPayoutCap} HBAR or ${openIntent.terms.usdcPayoutCap} test USDC`
                        : `Network fee up to ${openIntent.terms.maxFeeHbar} HBAR · ${openIntent.terms.network}`}
                    </span>
                  </div>
                  {openIntent.error && <span className="text-[13px] text-[#B3261E]">{openIntent.error}</span>}
                  <div className="flex flex-wrap items-center gap-2">
                    {openIntent.state === "awaiting_approvals" && approver && (
                      <button onClick={() => approve(openIntent.id)} disabled={!!busy} className={primary}>
                        {busy === `approve-${openIntent.id}` ? "Approving and sending…" : "Approve"}
                      </button>
                    )}
                    {openIntent.state === "awaiting_approvals" && canPropose && (
                      <button onClick={() => post(`reject-${openIntent.id}`, `/intents/${openIntent.id}/reject`)} disabled={!!busy} className={secondary}>
                        {busy === `reject-${openIntent.id}` ? "Rejecting…" : "Reject"}
                      </button>
                    )}
                    {(["signed", "submitted", "uncertain"].includes(openIntent.state) || (openIntent.kind === "update_policy" && openIntent.state === "authorized")) && canPropose && (
                      <button onClick={() => post(`reconcile-${openIntent.id}`, `/intents/${openIntent.id}/reconcile`)} disabled={!!busy} className={secondary}>
                        {busy === `reconcile-${openIntent.id}` ? "Checking…" : "Check status"}
                      </button>
                    )}
                  </div>
                  <details className="group">
                    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-[12px] text-[#6E6E73] hover:text-[#0D0D0D] [&::-webkit-details-marker]:hidden">
                      <span className="transition-transform group-open:rotate-90">›</span>
                      Full terms
                    </summary>
                    <div className="pt-2">
                      <Terms intent={openIntent} plans={plans} />
                    </div>
                  </details>
                </div>
              )}

              <div className="flex flex-col gap-4 rounded-[14px] bg-[#F7F7F5] p-4">
                <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-[#6E6E73]">Compute credits</span>
                    <span className="font-mono text-[28px] leading-none tabular-nums">{count(view.balances.credits)}</span>
                  </div>
                  <div className="flex gap-8">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-[#6E6E73]">HBAR</span>
                      <span className="font-mono text-[17px] leading-none tabular-nums">{hbarOf(view.balances.hbarWei)}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-[#6E6E73]">Test USDC</span>
                      <span className="font-mono text-[17px] leading-none tabular-nums">{usdcOf(view.balances.testUsdcUnits)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-black/[0.06] pt-3 text-[12px] text-[#6E6E73]">
                  <a href={accountUrl(walletAddress)} target="_blank" rel="noreferrer" title={walletAddress} className="font-mono text-[#0D0D0D] hover:underline">
                    {shortAddress(walletAddress)} ↗
                  </a>
                  <button onClick={() => copyAddress(walletAddress)} className="hover:text-[#0D0D0D]">
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <span>{approver ? "You approve every transaction" : "The financial approver signs every transaction"}</span>
                  <span className="ml-auto rounded-full bg-white px-2.5 py-0.5 text-[11px]">Hedera testnet</span>
                </div>
              </div>

              <Toggle label="Compute Treasury actions" value={activeTab} options={tabs} onChange={setTab} />

              <div className="flex flex-col gap-3 rounded-[14px] border border-[#E5E5E0] p-4">
                {activeTab === "deposit" && (
                  <>
                    <PanelTitle
                      title="Add HBAR from your wallet"
                      hint={
                        cheapest && shortfall > 0
                          ? `About ${Math.ceil(shortfall * 10) / 10} more HBAR covers ${planName(cheapest)} plus network fees.`
                          : "No approval needed. It shows up here in a few seconds."
                      }
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Amount value={deposit} onChange={setDeposit} unit="HBAR" label="Deposit amount in HBAR" />
                      <button onClick={depositFromMyWallet} disabled={busy === "deposit" || !(Number(deposit) > 0)} className={primary}>
                        {busy === "deposit" ? "Confirm in your wallet…" : "Deposit"}
                      </button>
                    </div>
                    <span className="text-[12px] text-[#8F8F8F]">You can also send HBAR to {shortAddress(walletAddress)} from any Hedera testnet wallet.</span>
                  </>
                )}

                {activeTab === "buy" && (
                  <>
                    <PanelTitle title="Buy compute credits" hint="Paid from the team wallet once you approve." />
                    {allowedPlans.length === 0 ? (
                      <p className="m-0 text-[13px] text-[#6E6E73]">No credit plans are allowed. {isOwner ? "Turn one on under Limits." : "Ask the team owner to allow one."}</p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {allowedPlans.map((p) => {
                          const tooLow = hbar !== null && hbar < planPrice(p);
                          return (
                            <div key={p.planId} className="flex items-center justify-between gap-3 rounded-[14px] border border-[#E5E5E0] p-3.5">
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-[15px] font-medium">{planName(p)}</span>
                                {tooLow ? (
                                  <button onClick={() => setTab("deposit")} className="w-fit text-left text-[12px] text-[#8A5300] underline underline-offset-2">
                                    Needs {planPrice(p)} HBAR, add HBAR first
                                  </button>
                                ) : (
                                  <span className="text-[12px] text-[#6E6E73]">{planPrice(p)} HBAR + network fee</span>
                                )}
                              </div>
                              <button
                                onClick={() => post(`buy-${p.planId}`, "/intents", { kind: "buy_credits", planId: Number(p.planId) })}
                                disabled={!!busy || !!openIntent || tooLow}
                                className={primary}
                              >
                                {busy === `buy-${p.planId}` ? "Preparing…" : "Buy"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {view.balances.credits !== null && view.balances.credits !== "0" && (
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E5E5E0] pt-3">
                        <span className="text-[13px] text-[#6E6E73]">Unused credits can go back to the team wallet.</span>
                        <button onClick={() => post("refund", "/intents", { kind: "refund" })} disabled={!!busy || !!openIntent} className={secondary}>
                          {busy === "refund" ? "Preparing…" : "Refund unused credits"}
                        </button>
                      </div>
                    )}
                    {busyNote}
                  </>
                )}

                {activeTab === "payout" && (
                  <>
                    <PanelTitle title="Pay out" hint={`Only to approved recipients, up to ${payoutCap} ${payoutUnit} per payout.`} />
                    {recipients.length === 0 ? (
                      <p className="m-0 text-[13px] text-[#6E6E73]">
                        No approved recipients yet.{" "}
                        {isOwner ? (
                          <button onClick={editLimits} className="underline underline-offset-2">
                            Add one under Limits
                          </button>
                        ) : (
                          "The team owner adds them under Limits."
                        )}
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Toggle label="Payout asset" value={payoutAsset} options={[["payout_hbar", "HBAR"], ["payout_usdc", "Test USDC"]]} onChange={setPayoutAsset} />
                        <select value={recipient} onChange={(e) => setPayoutRecipient(e.target.value)} aria-label="Recipient" title={recipient} className={`${field} min-w-0 pr-3 sm:flex-1`}>
                          {recipients.map((r) => (
                            <option key={r} value={r}>
                              {shortAddress(r)}
                            </option>
                          ))}
                        </select>
                        <Amount value={payoutAmount} onChange={setPayoutAmount} unit={payoutUnit} label="Payout amount" className="w-full sm:w-36" />
                        <button
                          onClick={async () => {
                            if (await post("payout", "/intents", { kind: payoutAsset, recipient, amount: payoutAmount.trim() })) setPayoutAmount("");
                          }}
                          disabled={!!busy || !!openIntent || !recipient || !(Number(payoutAmount) > 0)}
                          className={primary}
                        >
                          {busy === "payout" ? "Preparing…" : "Pay out"}
                        </button>
                      </div>
                    )}
                    {busyNote}
                  </>
                )}

                {activeTab === "limits" && view.limits && (
                  isOwner && editing ? (
                    <div className="flex flex-col gap-4">
                      <PanelTitle title="Edit wallet limits" hint="New limits apply once the financial approver approves them." />
                      <div className="flex flex-col gap-2">
                        <span className="text-[12px] text-[#6E6E73]">Credit plans the team can buy</span>
                        <div className="flex flex-wrap gap-2">
                          {plans.map((p) => {
                            const on = limitPlans.includes(p.planId);
                            return (
                              <button
                                key={p.planId}
                                aria-pressed={on}
                                onClick={() => setLimitPlans((cur) => (on ? cur.filter((x) => x !== p.planId) : [...cur, p.planId]))}
                                className={`flex h-9 items-center rounded-full border px-4 text-[13px] transition-colors ${
                                  on ? "border-[#0D0D0D] bg-[#0D0D0D] text-white" : "border-black/10 bg-white hover:bg-[#F7F7F5]"
                                }`}
                              >
                                {on ? "✓ " : ""}
                                {planName(p)} · {planPrice(p)} HBAR
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1.5 text-[12px] text-[#6E6E73]">
                          Largest HBAR payout
                          <Amount value={limitHbar} onChange={setLimitHbar} unit="HBAR" label="Largest HBAR payout" className="w-full" />
                        </label>
                        <label className="flex flex-col gap-1.5 text-[12px] text-[#6E6E73]">
                          Largest test USDC payout
                          <Amount value={limitUsdc} onChange={setLimitUsdc} unit="USDC" label="Largest test USDC payout" className="w-full" />
                        </label>
                      </div>
                      <label className="flex flex-col gap-1.5 text-[12px] text-[#6E6E73]">
                        Approved recipients, one address per line
                        <textarea
                          value={limitRecipients}
                          onChange={(e) => setLimitRecipients(e.target.value)}
                          rows={3}
                          spellCheck={false}
                          className="rounded-[14px] border border-black/10 bg-white px-3.5 py-2.5 font-mono text-[13px] text-[#0D0D0D] outline-none transition-colors focus:border-black/40"
                        />
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={async () => {
                            const proposed = await post("limits", "/intents", {
                              kind: "update_policy",
                              planIds: limitPlans.map(Number),
                              hbarPayoutCap: limitHbar.trim(),
                              usdcPayoutCap: limitUsdc.trim(),
                              recipients: limitRecipients.split(/[\s,]+/).filter(Boolean),
                            });
                            if (proposed) setEditing(false);
                          }}
                          disabled={!!busy || !limitPlans.length}
                          className={primary}
                        >
                          {busy === "limits" ? "Preparing…" : "Send for approval"}
                        </button>
                        <button onClick={() => setEditing(false)} disabled={!!busy} className={secondary}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <PanelTitle title="Wallet limits" hint="Privy refuses anything outside these limits, even with approval.">
                        {isOwner && (
                          <button onClick={editLimits} disabled={!!busy || !!openIntent} className={secondary}>
                            Edit limits
                          </button>
                        )}
                      </PanelTitle>
                      <dl className="m-0 grid gap-2 sm:grid-cols-3">
                        <Fact label="Credit plans">{planNames(view.limits.planIds.join(","), plans)}</Fact>
                        <Fact label="Largest payout">
                          {view.limits.hbarPayoutCap} HBAR · {view.limits.usdcPayoutCap} test USDC
                        </Fact>
                        <Fact label="Approved recipients">
                          {view.limits.recipients.length === 0 ? (
                            "none"
                          ) : (
                            <span className="flex flex-col font-mono">
                              {view.limits.recipients.map((r) => (
                                <span key={r} title={r}>
                                  {shortAddress(r)}
                                </span>
                              ))}
                            </span>
                          )}
                        </Fact>
                      </dl>
                      {!isOwner && <span className="text-[12px] text-[#8F8F8F]">Only the team owner can change these.</span>}
                      {isOwner && busyNote}
                    </>
                  )
                )}
              </div>

              {history.length > 0 && (
                <div className="flex flex-col">
                  <span className="pb-1 text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Activity</span>
                  <ul className="m-0 flex list-none flex-col p-0">
                    {(showAll ? history : history.slice(0, 5)).map((i) => {
                      const [label, tone] = STATUS[i.state] ?? [i.state, WAITING];
                      return (
                        <li key={i.id} className="border-b border-[#EFEFEA] last:border-b-0">
                          <details className="group">
                            <summary className="flex cursor-pointer list-none items-center gap-3 py-2.5 [&::-webkit-details-marker]:hidden">
                              <span className="min-w-0 flex-1 truncate text-[13px]">{headline(i)}</span>
                              <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] ${tone}`}>{label}</span>
                              <span className="hidden w-16 shrink-0 text-right text-[12px] text-[#8F8F8F] sm:block">{ago(i.createdAt)}</span>
                              <span className="shrink-0 text-xs text-[#8F8F8F] transition-transform group-open:rotate-90">›</span>
                            </summary>
                            <div className="flex flex-col gap-2 pb-3">
                              {i.result.creditsAdded && <span className="text-[12px] text-[#0B7A5D]">+{count(i.result.creditsAdded)} credits confirmed onchain</span>}
                              {i.result.policyUpdated && <span className="text-[12px] text-[#0B7A5D]">New limits are active in the Privy policy</span>}
                              {i.error && <span className="text-[12px] text-[#B3261E]">{i.error}</span>}
                              <Terms intent={i} plans={plans} />
                            </div>
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                  {history.length > 5 && (
                    <button onClick={() => setShowAll((s) => !s)} className="self-start pt-1 text-[12px] text-[#6E6E73] underline underline-offset-2">
                      {showAll ? "Show less" : `Show all ${history.length}`}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
