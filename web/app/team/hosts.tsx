"use client";

import { useCallback, useState } from "react";
import { formatEther, formatUnits } from "viem";
import { apiError } from "../../lib/api-error";
import { accountUrl, txUrl } from "../../lib/chain";
import { useAuthFetch } from "../components/use-auth-fetch";

// Team hosts: earnings still at linked hosts, collections waiting for their transfer,
// and funds received in the team wallet, kept apart. An owner creates a one-time link;
// the host operator signs it with the registered host key and collects from the host.

interface HostsView {
  me: { role: string };
  hosts: { host: string; registry: string | null; linkedAt: number | null; vaultTinybar: string | null; usdcUnits: string | null }[];
  pendingLinks: { code: string; expiresAt: number }[];
  collections: {
    id: string;
    hostAddress: string;
    asset: "hbar" | "usdc";
    state: "pending" | "received";
    withdrawTx: string | null;
    withdrawnTinybar: string | null;
    transferTx: string | null;
    receivedAmount: string | null;
    createdAt: number;
  }[];
  totals: {
    atHosts: { hbarTinybar: string | null; usdcUnits: string | null };
    collectionPending: { hbarTinybar: string };
    received: { hbarWei: string; usdcUnits: string };
  };
}

const short = (n: string) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });
const tinybar = (v: string | null) => (v === null ? "unknown" : `${short(formatUnits(BigInt(v), 8))} HBAR`);
const weibar = (v: string) => `${short(formatEther(BigInt(v)))} HBAR`;
const usdc = (v: string | null) => (v === null ? "unknown" : `${short(formatUnits(BigInt(v), 6))} test USDC`);

export default function TeamHosts({ orgId, mock }: { orgId: string; mock: boolean }) {
  const authFetch = useAuthFetch();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<HostsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<{ command: string; expiresAt: number } | null>(null);
  const base = `/api/gw/api/team/orgs/${encodeURIComponent(orgId)}/hosts`;

  const load = useCallback(async () => {
    if (mock) return;
    try {
      const r = await authFetch(base);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 501 ? "Host links are not available on this gateway yet." : apiError(d, r.status));
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

  async function post(tag: string, path: string) {
    setBusy(tag);
    setErr(null);
    try {
      const r = await authFetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(apiError(d, r.status));
      return d;
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).slice(0, 240));
      return null;
    } finally {
      setBusy(null);
      await load();
    }
  }

  const owner = view?.me.role === "owner";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[#E5E5E0] px-4 py-3">
      <button onClick={toggle} className="flex flex-wrap items-baseline gap-x-3 text-left">
        <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Hosts</span>
        <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">{view ? `${view.hosts.length} linked · ${weibar(view.totals.received.hbarWei)} received` : "host earnings"}</span>
        <span className={`font-mono text-xs text-[#8F8F8F] transition-transform ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && !mock && (
        <>
          {!view ? (
            err ? <span className="font-mono text-[11px] text-[#B3261E]">{err}</span> : <div className="h-16 animate-pulse rounded-lg bg-[#F4F4F4]" />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[
                  ["Earnings at hosts", `${tinybar(view.totals.atHosts.hbarTinybar)} · ${usdc(view.totals.atHosts.usdcUnits)}`],
                  ["Collection pending", tinybar(view.totals.collectionPending.hbarTinybar)],
                  ["Received in team wallet", `${weibar(view.totals.received.hbarWei)} · ${usdc(view.totals.received.usdcUnits)}`],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-[#F7F7F5] px-3 py-2">
                    <div className="text-[11px] text-[#6E6E73]">{label}</div>
                    <div className="font-mono text-xs tabular-nums">{value}</div>
                  </div>
                ))}
              </div>

              {view.hosts.map((h) => (
                <div key={h.host} className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[#5D5D5D]">
                  <a href={accountUrl(h.host)} target="_blank" rel="noreferrer" className="break-all underline">{h.host}</a>
                  <span>{tinybar(h.vaultTinybar)} in the vault</span>
                  <span>{usdc(h.usdcUnits)} at the host</span>
                  {owner && (
                    <button onClick={() => post(`unlink-${h.host}`, `/${h.host}/revoke`)} disabled={!!busy} className="ml-auto rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">
                      Unlink
                    </button>
                  )}
                </div>
              ))}

              {owner && (
                <div className="flex flex-col gap-2 rounded-lg border border-dashed border-black/15 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-[#5D5D5D]">Link a host you operate</span>
                    <button
                      onClick={async () => {
                        const d = await post("link", "/links");
                        if (d) setCreated({ command: d.command, expiresAt: d.expiresAt });
                      }}
                      disabled={!!busy}
                      className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40"
                    >
                      {busy === "link" ? "creating…" : "Create link code"}
                    </button>
                  </div>
                  {created && (
                    <>
                      <pre className="m-0 overflow-x-auto rounded-lg bg-[#0D0D0D] p-3 font-mono text-[11px] text-[#E6EAF0]">{created.command}</pre>
                      <span className="text-[11px] text-[#6E6E73]">
                        Run it on the host machine before {new Date(created.expiresAt).toLocaleTimeString()}. The host key signs this team, its registry, and the team wallet as the only collection destination.
                        Then run tor-host collect, or tor-host collect --usdc for test USDC.
                      </span>
                    </>
                  )}
                </div>
              )}

              {view.collections.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Collections</span>
                  {view.collections.map((c) => (
                    <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[#5D5D5D]">
                      <span>{new Date(c.createdAt).toISOString().replace("T", " ").slice(0, 16)}</span>
                      <span className={`rounded-full px-2 py-0.5 ${c.state === "received" ? "bg-[#E7F5EE] text-[#0B7A5D]" : "bg-[#FDF3E2] text-[#8A5300]"}`}>
                        {c.state === "received" ? "received" : "collection pending"}
                      </span>
                      <span>{c.asset === "usdc" ? usdc(c.receivedAmount) : c.receivedAmount ? weibar(c.receivedAmount) : tinybar(c.withdrawnTinybar)}</span>
                      <span className="break-all">from {c.hostAddress}</span>
                      {c.withdrawTx && <a href={txUrl(c.withdrawTx)} target="_blank" rel="noreferrer" className="underline">withdrawal ↗</a>}
                      {c.transferTx && <a href={txUrl(c.transferTx)} target="_blank" rel="noreferrer" className="underline">transfer ↗</a>}
                    </div>
                  ))}
                </div>
              )}

              <span className="font-mono text-[11px] text-[#8F8F8F]">Host keys stay on host machines. The team wallet controls funds only after they are collected.</span>
              {err && <span className="font-mono text-[11px] text-[#B3261E]">{err}</span>}
            </>
          )}
        </>
      )}
    </div>
  );
}
