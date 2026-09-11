"use client";

import { useCallback, useState } from "react";
import { useAuthorizationSignature, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, formatEther, parseEther } from "viem";
import { apiError } from "../../lib/api-error";
import { accountUrl, txUrl } from "../../lib/chain";
import { hederaTestnet } from "../../lib/hedera-chains";
import { friendlyTxError } from "../../lib/tx-errors";
import { useAuthFetch } from "../components/use-auth-fetch";

// Team treasury: the Privy organization wallet behind shared compute credits.
// Deposits come from your own wallet. Purchases, refunds, and payouts are Privy
// intents: an owner or manager proposes exact terms, the financial approver
// authorizes with their session, the broker key co-signs, and the gateway
// broadcasts and confirms on Hedera testnet.

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

interface TreasuryView {
  network: string;
  team: { walletAddress: string | null; state: string; approverUserId: string | null; payoutRecipients: string[] } | null;
  balances: { hbarWei: string | null; credits: string | null; testUsdcUnits: string | null };
  plans: { planId: string; priceTinybar: string; credits: string; allowed: boolean }[];
  limits: { planIds: string[]; hbarPayoutCap: string; usdcPayoutCap: string; recipients: string[] } | null;
  intents: Intent[];
  me: { role: string; financialApprover: boolean };
}

const STATE_LABEL: Record<string, string> = {
  proposed: "proposed",
  awaiting_approvals: "waiting for approval",
  authorized: "authorized",
  signed: "signed",
  submitted: "submitted",
  confirmed: "confirmed",
  denied: "rejected",
  expired: "expired",
  reverted: "reverted",
  cancelled: "cancelled",
  uncertain: "needs reconciliation",
  failed: "failed",
};

const hbarOf = (wei: string | null) => (wei === null ? "—" : Number(formatEther(BigInt(wei))).toLocaleString("en-US", { maximumFractionDigits: 4 }));
const usdcOf = (units: string | null) => (units === null ? "—" : (Number(units) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 }));

function stateTone(state: string): string {
  if (state === "confirmed") return "bg-[#E7F5EE] text-[#0B7A5D]";
  if (["denied", "expired", "reverted", "cancelled", "failed"].includes(state)) return "bg-[#FDECEA] text-[#B3261E]";
  return "bg-[#FDF3E2] text-[#8A5300]";
}

export default function TeamTreasury({ orgId, mock }: { orgId: string; mock: boolean }) {
  const authFetch = useAuthFetch();
  const { wallets } = useWallets();
  const { generateAuthorizationSignature } = useAuthorizationSignature();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TreasuryView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deposit, setDeposit] = useState("11");
  const [payoutAsset, setPayoutAsset] = useState<"payout_hbar" | "payout_usdc">("payout_hbar");
  const [payoutRecipient, setPayoutRecipient] = useState("");
  const [payoutAmount, setPayoutAmount] = useState("");
  const [editing, setEditing] = useState(false);
  const [limitPlans, setLimitPlans] = useState<string[]>([]);
  const [limitHbar, setLimitHbar] = useState("");
  const [limitUsdc, setLimitUsdc] = useState("");
  const [limitRecipients, setLimitRecipients] = useState("");
  const base = `/api/gw/api/team/orgs/${encodeURIComponent(orgId)}`;

  const load = useCallback(async () => {
    if (mock) return;
    try {
      const r = await authFetch(`${base}/treasury`);
      const d = await r.json();
      if (!r.ok) throw new Error(apiError(d, r.status));
      setView(d);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 200));
    }
  }, [authFetch, base, mock]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void load();
  }

  async function post(tag: string, path: string, body: Record<string, unknown> = {}) {
    setBusy(tag);
    setErr(null);
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
    try {
      await wallet.switchChain(hederaTestnet.id);
      const provider = await wallet.getEthereumProvider();
      const client = createWalletClient({ account: wallet.address as `0x${string}`, chain: hederaTestnet, transport: custom(provider) });
      await client.sendTransaction({ to: to as `0x${string}`, value: parseEther(deposit) });
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
    setEditing(true);
  }

  const team = view?.team;
  const canPropose = view?.me.role === "owner" || view?.me.role === "manager";
  const isOwner = view?.me.role === "owner";
  const openIntent = view?.intents.find((i) => ["proposed", "awaiting_approvals", "authorized", "signed", "submitted", "uncertain"].includes(i.state));

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#E5E5E0] px-4 py-3">
      <button onClick={toggle} className="flex flex-wrap items-baseline gap-x-3 text-left">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Treasury</span>
        <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">
          {view ? `${view.balances.credits ?? "—"} credits · ${hbarOf(view.balances.hbarWei)} HBAR · Hedera testnet` : "Privy team wallet"}
        </span>
        <span className={`font-mono text-xs text-[#8F8F8F] transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && !mock && (
        <>
          {!view ? (
            <div className="h-16 animate-pulse rounded-lg bg-[#F4F4F4]" />
          ) : !team?.walletAddress || team.state !== "active" ? (
            <p className="m-0 text-sm text-[#6E6E73]">This team has no active treasury wallet. Teams created before team wallets need to be recreated.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[
                  ["Vault credits", view.balances.credits ?? "—"],
                  ["HBAR in wallet", hbarOf(view.balances.hbarWei)],
                  ["Test USDC", usdcOf(view.balances.testUsdcUnits)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-[#F7F7F5] px-3 py-2">
                    <div className="text-[11px] text-[#6E6E73]">{label}</div>
                    <div className="font-mono text-sm tabular-nums">{value}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[#6E6E73]">
                <a href={accountUrl(team.walletAddress)} target="_blank" rel="noreferrer" className="break-all underline">{team.walletAddress}</a>
                <span>{view.me.financialApprover ? "you approve treasury transactions" : "approval by the team's financial approver"}</span>
                <span>Hedera testnet · test assets only</span>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-black/15 p-3">
                <span className="text-xs text-[#5D5D5D]">Deposit HBAR</span>
                <input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" className="h-8 w-24 rounded-lg border border-black/10 px-2.5 font-mono text-xs" aria-label="Deposit amount in HBAR" />
                <button onClick={depositFromMyWallet} disabled={busy === "deposit" || !deposit.trim()} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">
                  {busy === "deposit" ? "confirm in wallet…" : "Deposit from my wallet"}
                </button>
                <span className="font-mono text-[11px] text-[#8F8F8F]">covers the plan price plus network fees</span>
              </div>

              {view.limits && (
                <div className="flex flex-col gap-2 rounded-lg border border-dashed border-black/15 p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs text-[#5D5D5D]">Wallet limits</span>
                    <span className="font-mono text-[11px] text-[#6E6E73]">
                      plans {view.limits.planIds.join(", ")} · payouts up to {view.limits.hbarPayoutCap} HBAR or {view.limits.usdcPayoutCap} test USDC per transaction · {view.limits.recipients.length} approved recipient{view.limits.recipients.length === 1 ? "" : "s"}
                    </span>
                    {isOwner && !editing && (
                      <button onClick={editLimits} disabled={!!busy || !!openIntent} className="ml-auto rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] disabled:opacity-40">
                        Change limits
                      </button>
                    )}
                  </div>
                  {isOwner && editing && (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-[#6E6E73]">Credit plans the team may buy</span>
                        {view.plans.map((p) => {
                          const on = limitPlans.includes(p.planId);
                          return (
                            <button
                              key={p.planId}
                              onClick={() => setLimitPlans((cur) => (on ? cur.filter((x) => x !== p.planId) : [...cur, p.planId]))}
                              className={`rounded-full border px-3 py-1 font-mono text-[11px] ${on ? "border-black bg-black text-white" : "border-black/10 bg-white"}`}
                            >
                              {Number(p.credits).toLocaleString("en-US")} credits · {Number(p.priceTinybar) / 1e8} HBAR
                            </button>
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <label className="flex flex-col gap-1 text-[11px] text-[#6E6E73]">
                          Max HBAR payout per transaction
                          <input value={limitHbar} onChange={(e) => setLimitHbar(e.target.value)} inputMode="decimal" className="h-8 w-32 rounded-lg border border-black/10 px-2.5 font-mono text-xs text-black" />
                        </label>
                        <label className="flex flex-col gap-1 text-[11px] text-[#6E6E73]">
                          Max test USDC payout per transaction
                          <input value={limitUsdc} onChange={(e) => setLimitUsdc(e.target.value)} inputMode="decimal" className="h-8 w-32 rounded-lg border border-black/10 px-2.5 font-mono text-xs text-black" />
                        </label>
                      </div>
                      <label className="flex flex-col gap-1 text-[11px] text-[#6E6E73]">
                        Approved payout recipients, one wallet address per line
                        <textarea value={limitRecipients} onChange={(e) => setLimitRecipients(e.target.value)} rows={3} className="rounded-lg border border-black/10 px-2.5 py-2 font-mono text-xs text-black" />
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
                          className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40"
                        >
                          {busy === "limits" ? "preparing…" : "Propose new limits"}
                        </button>
                        <button onClick={() => setEditing(false)} disabled={!!busy} className="rounded-full border border-black/15 px-3 py-1 text-[11px] disabled:opacity-40">
                          Cancel
                        </button>
                        <span className="font-mono text-[11px] text-[#8F8F8F]">the financial approver authorizes the change; Privy then enforces it on every signature</span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {canPropose && (
                <div className="flex flex-col gap-2 rounded-lg border border-dashed border-black/15 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-[#5D5D5D]">Buy compute credits</span>
                    {view.plans.filter((p) => p.allowed).map((p) => (
                      <button
                        key={p.planId}
                        onClick={() => post(`buy-${p.planId}`, "/intents", { kind: "buy_credits", planId: Number(p.planId) })}
                        disabled={!!busy || !!openIntent}
                        className="rounded-full border border-black/10 bg-white px-3 py-1 font-mono text-[11px] disabled:opacity-40"
                      >
                        {busy === `buy-${p.planId}` ? "preparing…" : `${Number(p.credits).toLocaleString("en-US")} credits · ${Number(p.priceTinybar) / 1e8} HBAR`}
                      </button>
                    ))}
                    <button
                      onClick={() => post("refund", "/intents", { kind: "refund" })}
                      disabled={!!busy || !!openIntent || view.balances.credits === "0"}
                      className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] disabled:opacity-40"
                    >
                      Refund unused credits
                    </button>
                  </div>
                  {team.payoutRecipients.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-[#5D5D5D]">Pay out</span>
                      <select value={payoutAsset} onChange={(e) => setPayoutAsset(e.target.value as "payout_hbar" | "payout_usdc")} className="h-8 rounded-lg border border-black/10 bg-white px-2 text-xs" aria-label="Payout asset">
                        <option value="payout_hbar">HBAR</option>
                        <option value="payout_usdc">test USDC</option>
                      </select>
                      <select value={payoutRecipient} onChange={(e) => setPayoutRecipient(e.target.value)} className="h-8 max-w-[220px] rounded-lg border border-black/10 bg-white px-2 font-mono text-xs" aria-label="Payout recipient">
                        <option value="">approved recipient…</option>
                        {team.payoutRecipients.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                      <input value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} placeholder="amount" inputMode="decimal" className="h-8 w-24 rounded-lg border border-black/10 px-2.5 font-mono text-xs" aria-label="Payout amount" />
                      <button
                        onClick={() => post("payout", "/intents", { kind: payoutAsset, recipient: payoutRecipient, amount: payoutAmount })}
                        disabled={!!busy || !!openIntent || !payoutRecipient || !payoutAmount.trim()}
                        className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40"
                      >
                        {busy === "payout" ? "preparing…" : "Propose payout"}
                      </button>
                    </div>
                  )}
                  {openIntent && <span className="font-mono text-[11px] text-[#8F8F8F]">finish the open transaction below before proposing another</span>}
                </div>
              )}

              {view.intents.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Treasury transactions</span>
                  {view.intents.map((i) => (
                    <div key={i.id} className="flex flex-col gap-1.5 rounded-lg bg-[#F7F7F5] p-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-medium">{i.terms.action}</span>
                        <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${stateTone(i.state)}`}>{STATE_LABEL[i.state] ?? i.state}</span>
                        {i.transactionHash && (
                          <a href={txUrl(i.transactionHash)} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[11px] underline">HashScan ↗</a>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-[#5D5D5D]">
                        {i.terms.credits && <span>{i.kind === "refund" ? "refund" : "receive"} {i.terms.credits} credits</span>}
                        {i.terms.priceHbar && <span>price {i.terms.priceHbar} HBAR</span>}
                        {i.terms.amount && <span>{i.terms.amount} {i.kind === "payout_usdc" ? "test USDC" : "HBAR"}</span>}
                        {i.terms.recipient && <span className="break-all">to {i.terms.recipient}</span>}
                        {i.terms.vault && <span className="break-all">vault {i.terms.vault}</span>}
                        {i.terms.plans && <span>plans {i.terms.plans}</span>}
                        {i.terms.hbarPayoutCap && <span>HBAR payouts up to {i.terms.hbarPayoutCap}</span>}
                        {i.terms.usdcPayoutCap && <span>test USDC payouts up to {i.terms.usdcPayoutCap}</span>}
                        {i.terms.recipients && <span className="break-all">recipients {i.terms.recipients}</span>}
                        {i.terms.previous && <span>was {i.terms.previous}</span>}
                        {i.terms.maxFeeHbar && <span>max fee {i.terms.maxFeeHbar} HBAR</span>}
                        {i.terms.nonce && <span>nonce {i.terms.nonce}</span>}
                        <span>{i.terms.network}</span>
                      </div>
                      {i.result.creditsAdded && <span className="font-mono text-[11px] text-[#0B7A5D]">+{i.result.creditsAdded} credits confirmed onchain</span>}
                      {i.result.policyUpdated && <span className="font-mono text-[11px] text-[#0B7A5D]">new limits confirmed in the Privy policy</span>}
                      {i.error && <span className="font-mono text-[11px] text-[#B3261E]">{i.error}</span>}
                      <div className="flex flex-wrap items-center gap-2">
                        {i.state === "awaiting_approvals" && view.me.financialApprover && (
                          <button onClick={() => approve(i.id)} disabled={!!busy} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">
                            {busy === `approve-${i.id}` ? "approving and broadcasting…" : "Approve these terms"}
                          </button>
                        )}
                        {i.state === "awaiting_approvals" && canPropose && (
                          <button onClick={() => post(`reject-${i.id}`, `/intents/${i.id}/reject`)} disabled={!!busy} className="rounded-full border border-black/15 px-3 py-1 text-[11px] disabled:opacity-40">
                            Reject
                          </button>
                        )}
                        {(["signed", "submitted", "uncertain"].includes(i.state) || (i.kind === "update_policy" && i.state === "authorized")) && canPropose && (
                          <button onClick={() => post(`reconcile-${i.id}`, `/intents/${i.id}/reconcile`)} disabled={!!busy} className="rounded-full border border-black/15 px-3 py-1 text-[11px] disabled:opacity-40">
                            {busy === `reconcile-${i.id}` ? "checking…" : "Reconcile"}
                          </button>
                        )}
                        {i.approvals.length > 0 && (
                          <span className="font-mono text-[11px] text-[#8F8F8F]">
                            approvals: {i.approvals.map((a) => (a.method === "privy_user" ? "financial approver" : "broker key")).join(" + ")}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
      {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
    </div>
  );
}
