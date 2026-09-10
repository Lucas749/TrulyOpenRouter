"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Copy, Cpu, ExternalLink, Link2, LoaderCircle, MapPin, Plus, RefreshCw, Server, Wallet } from "lucide-react";
import { hbarLabel, hostAddresses, loadHost, loadHostDashboard, storedHosts, storeHosts, totalHostAmount, type HostDashboard, type HostEntry } from "../../../lib/host-dashboard";
import { usdLabel } from "../../../lib/money";
import { hostLocation } from "../../../lib/host-locations";

const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-[#E5E5E0] bg-white px-4 text-sm font-medium transition hover:bg-[#F5F5F5] disabled:cursor-wait disabled:opacity-50";
const primary = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-[#0D0D0D] px-4 text-sm font-medium text-white transition hover:bg-[#262626]";
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-4)}`;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState<string | null>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setMessage("Copied"); }
    catch { setMessage("Select and copy the text below"); }
    setTimeout(() => setMessage(null), 2200);
  }
  return <button onClick={copy} title={value} className={button}>{message === "Copied" ? <Check size={14} /> : <Copy size={14} />}{message ?? label}</button>;
}

function HostCard({ entry }: { entry: HostEntry }) {
  if (entry.status !== "ready") return (
    <article className="rounded-2xl border border-[#E5E5E0] bg-[#F5F5F5] p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F5F5F5] text-[#8B6B29]"><Server size={19} /></div>
        <div className="min-w-0 flex-1"><h3 className="m-0 text-sm font-semibold">{entry.status === "pending" ? "Awaiting registration" : "Details unavailable"}</h3><p className="mt-1 font-mono text-xs text-[#737373]">{short(entry.address)}</p></div>
        <span className="rounded-full bg-[#F5F5F5] px-2.5 py-1 text-[11px] font-medium text-[#8B6B29]">{entry.status === "pending" ? "Setup incomplete" : "Try refreshing"}</span>
      </div>
      <p className="mb-4 mt-4 max-w-lg text-sm leading-relaxed text-[#737373]">{entry.message}</p>
      <div className="flex flex-wrap gap-2"><CopyButton value={entry.address} label="Copy address" />{entry.status === "pending" && <Link className={button} href={`/host/onboarding?address=${entry.address}`}>View setup <ArrowUpRight size={14} /></Link>}</div>
    </article>
  );
  const h = entry.host;
  return (
    <article className="overflow-hidden rounded-2xl border border-[#E5E5E0] bg-white">
      <div className="flex flex-wrap items-center gap-3 p-5 sm:p-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#E5E5E0] bg-[#F5F5F5] text-[#0D0D0D]"><Cpu size={24} strokeWidth={1.5} /></div>
        <div className="min-w-0 flex-1"><h3 className="m-0 break-all text-lg font-semibold tracking-tight">{h.modelId}</h3><div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#8F8F8F]"><span className="font-mono" title={h.address}>{short(h.address)}</span><span className="inline-flex items-center gap-1"><MapPin size={12} />{hostLocation(h.geo ?? h.region)?.label ?? (h.geo ?? h.region ?? "Location not reported").replace(/-/g, " ")}</span></div></div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${h.active ? "bg-[#F5F5F5] text-[#0D0D0D]" : "bg-[#F5F5F5] text-[#737373]"}`}><span className={`h-1.5 w-1.5 rounded-full ${h.active ? "bg-[#10A37F]" : "bg-[#8F8F8F]"}`} />{h.paused ? "Paused" : h.active ? "Registered" : "Inactive"}</span>
      </div>
      <div className="grid grid-cols-2 gap-y-5 border-y border-[#EDEDED] px-5 py-5 sm:grid-cols-4 sm:px-6">
        {[["Requests · 24h", h.calls24h.toLocaleString("en-US"), `${h.fail24h} failed`], ["Available earnings", hbarLabel(h.earningsWei), "HBAR"], ["Price / request", usdLabel(h.pricePerReq), `${usdLabel(h.pricePer1kTokens)} / 1k tokens`], ["Staked", hbarLabel(h.stake), "HBAR locked"]].map(([title, value, hint]) => <div key={title} className="min-w-0 pr-3"><p className="m-0 text-[11px] font-medium text-[#8F8F8F]">{title}</p><p className="mb-0 mt-2 break-all font-mono text-xl tracking-tight">{value}</p><p className="mb-0 mt-1 text-[11px] text-[#8F8F8F]">{hint}</p></div>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
        <p className="m-0 text-xs text-[#737373]">{h.paused ? "Routing paused · resume with tor-host start" : h.calls24h ? `${h.tokensRecent.toLocaleString("en-US")} tokens in recent receipts` : "Ready for your first routed request"}</p>
        <Link href={`/network/host/${h.address}`} className="inline-flex items-center gap-1 text-xs font-medium text-[#0D0D0D]">View activity <ArrowUpRight size={14} /></Link>
      </div>
      {h.challenged && <p className="m-0 border-t border-[#EDEDED] bg-[#F5F5F5] px-6 py-3 text-xs text-[#8B6B29]">This host has a challenge awaiting review.</p>}
      {h.registry && <details className="group border-t border-[#EDEDED] px-5 sm:px-6"><summary className="flex cursor-pointer list-none items-center justify-between py-3 text-xs text-[#737373]">Host details &amp; stake management <ChevronDown size={14} className="transition group-open:rotate-180" /></summary><div className="space-y-3 pb-5 text-xs text-[#737373]"><p className="break-all">Host address: <span className="font-mono">{h.address}</span></p><p>Latest heartbeat: {h.lastHeartbeat ? new Date(h.lastHeartbeat).toLocaleString() : "Not available"}</p><p>Sign stake actions on the machine that holds your host key. Deregistering begins the stake release waiting period. Use tor-host stop for a temporary shutdown.</p><code className="block overflow-x-auto rounded-lg bg-[#F5F5F5] p-3 font-mono text-[11px] text-[#0D0D0D]">{`cast send ${h.registry} "${h.registeredActive ? "deregister" : "release"}()" --rpc-url https://testnet.hashio.io/api --private-key <your-host-key>`}</code><CopyButton label={h.registeredActive ? "Copy deregister command" : "Copy release command"} value={`cast send ${h.registry} "${h.registeredActive ? "deregister" : "release"}()" --rpc-url https://testnet.hashio.io/api --private-key <your-host-key>`} /></div></details>}
    </article>
  );
}

export default function HostDashboardPage() {
  const { ready, user, login } = usePrivy();
  const userId = user?.id ?? null;
  const [dashboard, setDashboard] = useState<HostDashboard | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [lookup, setLookup] = useState("");
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const [tracking, setTracking] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      setRefreshing(true);
      try {
        const next = await loadHostDashboard(userId, storedHosts(), controller.signal);
        if (!controller.signal.aborted) setDashboard(next);
      } finally {
        if (!controller.signal.aborted) { setRefreshing(false); timer = setTimeout(() => { void refresh().catch(() => {}); }, 15000); }
      }
    }
    void refresh().catch(() => {});
    return () => { controller.abort(); clearTimeout(timer); };
  }, [ready, userId, refreshKey]);

  async function track(event: React.FormEvent) {
    event.preventDefault();
    const address = hostAddresses([lookup.trim()])[0];
    if (!address) { setLookupMsg("Enter a host address: 0x followed by 40 letters or numbers."); return; }
    setTracking(true); setLookupMsg(null);
    try {
      const entry = await loadHost(address);
      if (entry.status === "error") { setLookupMsg(entry.message); return; }
      storeHosts([...storedHosts(), address]);
      setLookup(""); setLookupMsg("Host saved to this browser."); setRefreshKey((n) => n + 1);
    } catch { setLookupMsg("Browser storage is unavailable. Log in to see hosts linked to your account."); }
    finally { setTracking(false); }
  }

  const entries = [...(dashboard?.entries ?? [])].sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready"));
  const hosts = entries.flatMap((e) => e.status === "ready" ? [e.host] : []);
  const active = hosts.filter((h) => h.active).length;
  const requests = hosts.reduce((n, h) => n + h.calls24h, 0);
  const balance = dashboard ? totalHostAmount(entries, "earningsWei") : null;
  const stake = dashboard ? totalHostAmount(entries, "stake") : null;
  const incomplete = entries.length - hosts.length;

  return (
    <div className="min-h-screen bg-[#FFFFFF] font-sans text-[#0D0D0D]">
      <header className="border-b border-[#E5E5E0] bg-white"><div className="mx-auto flex h-[72px] max-w-[1248px] items-center justify-between gap-5 px-5 sm:px-8"><Link href="/" className="text-lg font-semibold tracking-tight">Truly<span className="font-normal text-[#8F8F8F]">OpenRouter</span></Link><nav className="hidden items-center gap-7 text-sm text-[#737373] sm:flex"><Link href="/chat" className="hover:text-black">Chat</Link><Link href="/network" className="hover:text-black">Network</Link><Link href="/host" className="font-medium text-[#0D0D0D]">Serve</Link></nav><Link href="/account" className="text-xs text-[#737373]">Account <ArrowUpRight className="ml-1 inline" size={13} /></Link></div></header>
      <main className="mx-auto max-w-[1248px] px-5 pb-16 pt-9 sm:px-8 sm:pt-12">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-5"><div><Link href="/host" className="text-xs font-medium text-[#737373]">Serve / Your workspace</Link><h1 className="mb-2 mt-3 text-[34px] font-semibold leading-tight tracking-[-0.04em] sm:text-[40px]">My hosts</h1><p className="m-0 text-sm text-[#737373]">Your models, activity, and earnings. All in one place.</p></div><div className="flex gap-2"><button onClick={() => setRefreshKey((n) => n + 1)} disabled={refreshing} className={button}><RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />Refresh</button><Link href="/host" className={primary}><Plus size={16} />Add a host</Link></div></div>
        {dashboard?.notice && <div role="status" className="mb-5 rounded-xl border border-[#E5E5E0] bg-[#F5F5F5] px-4 py-3 text-sm text-[#8B6B29]">{dashboard.notice}</div>}
        <section aria-label="Host overview" className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
          <div className="relative col-span-2 overflow-hidden rounded-2xl bg-[#0D0D0D] p-6 text-white sm:col-span-1"><div className="flex items-center justify-between text-[#BFBFBF]"><span className="text-xs font-medium">Available to withdraw</span><Wallet size={18} strokeWidth={1.5} /></div><p className="mb-5 mt-6 break-all font-mono text-[34px] leading-none tracking-tight">{hbarLabel(balance)} <span className="text-sm text-[#BFBFBF]">HBAR</span></p><p className="m-0 text-xs leading-relaxed text-[#BFBFBF]">{balance === null ? incomplete ? `${incomplete} tracked host ${incomplete === 1 ? "balance is" : "balances are"} unavailable` : "Loading host balances" : balance === "0" ? "Earnings appear as your hosts serve requests." : "Your earnings stay available until you withdraw."}</p></div>
          <div className="rounded-2xl border border-[#E5E5E0] bg-white p-6"><div className="flex items-center justify-between text-[#737373]"><span className="text-xs font-medium">Active hosts</span><Server size={18} strokeWidth={1.5} /></div><p className="mb-5 mt-6 font-mono text-[34px] leading-none tracking-tight">{dashboard ? active : "—"} <span className="text-sm text-[#8F8F8F]">/ {dashboard ? entries.length : "—"} tracked</span></p><p className="m-0 text-xs text-[#737373]">{incomplete ? `${incomplete} ${incomplete === 1 ? "host needs" : "hosts need"} attention below` : dashboard ? `${hbarLabel(stake)} HBAR staked across your hosts` : "Loading your host registrations"}</p></div>
          <div className="rounded-2xl border border-[#E5E5E0] bg-white p-6"><div className="flex items-center justify-between text-[#737373]"><span className="text-xs font-medium">Requests · 24h</span><ArrowDownLeft size={19} strokeWidth={1.5} /></div><p className="mb-5 mt-6 font-mono text-[34px] leading-none tracking-tight">{dashboard ? requests.toLocaleString("en-US") : "—"}</p><p className="m-0 text-xs text-[#737373]">{incomplete ? "Across hosts with available data" : "Routed requests in the last 24 hours"}</p></div>
        </section>
        <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_290px]">
          <section aria-label="Your hosts" className="min-w-0"><div className="mb-4 flex items-center justify-between"><h2 className="m-0 text-base font-semibold">Your hosts <span className="ml-2 rounded-md bg-[#F5F5F5] px-2 py-0.5 font-mono text-xs font-normal text-[#737373]">{dashboard ? entries.length : "…"}</span></h2><span className="inline-flex items-center gap-1.5 text-[11px] text-[#8F8F8F]"><span className={`h-1.5 w-1.5 rounded-full ${refreshing ? "bg-[#8F8F8F]" : "bg-[#10A37F]"}`} />{refreshing ? "Updating" : "Refreshes every 15s"}</span></div>
            {!dashboard ? <div aria-label="Loading hosts" className="h-60 animate-pulse rounded-2xl border border-[#E5E5E0] bg-white" /> : !entries.length ? <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[#E5E5E0] bg-white px-7 py-12 text-center"><div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#F5F5F5] text-[#0D0D0D]"><Server size={25} strokeWidth={1.4} /></div><h3 className="m-0 text-lg font-medium">Your first host starts here</h3><p className="mb-6 mt-2 max-w-sm text-sm leading-relaxed text-[#737373]">{userId ? "Set up a model on your machine, or link an existing host to your account." : "Log in to see your linked hosts, or track a host address in this browser."}</p><div className="flex flex-wrap justify-center gap-2">{!userId && <button onClick={login} className={primary}>Log in <ArrowUpRight size={14} /></button>}<Link href="/host" className={userId ? primary : button}>Set up a host <Plus size={14} /></Link></div></div> : <div className="space-y-4">{entries.map((entry) => <HostCard key={entry.address} entry={entry} />)}</div>}
          </section>
          <aside className="space-y-5 lg:pt-9">
            <div className="rounded-2xl border border-[#E5E5E0] bg-white p-5"><h2 className="m-0 text-sm font-semibold">Connect your machine</h2><p className="mb-4 mt-2 text-xs leading-relaxed text-[#737373]">Already running a host? Link it to see its activity on any device.</p><Link href="/host/link" className="inline-flex items-center gap-2 text-xs font-medium text-[#0D0D0D]"><Link2 size={14} />Link an existing host <ArrowUpRight size={13} /></Link><div className="mb-4 mt-5 border-t border-[#EDEDED]" /><form onSubmit={track}><label htmlFor="host-address" className="mb-2 block text-xs font-medium">Or track an address</label><input id="host-address" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" className="h-10 w-full min-w-0 rounded-lg border border-[#E5E5E0] bg-[#F5F5F5] px-3 font-mono text-xs outline-none focus:border-[#0D0D0D] focus:ring-2 focus:ring-[#EDEDED]" /><button disabled={tracking} type="submit" className={`${button} mt-2 w-full`}>{tracking ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}Track host</button>{lookupMsg && <p role="status" className="mb-0 mt-3 text-xs leading-relaxed text-[#737373]">{lookupMsg}</p>}</form></div>
            <div className="rounded-2xl border border-[#E5E5E0] bg-[#F5F5F5] p-5"><div className="mb-3 flex items-center gap-2 text-[#0D0D0D]"><Wallet size={16} /><h2 className="m-0 text-sm font-semibold">Your earnings, your keys</h2></div><p className="m-0 text-xs leading-relaxed text-[#737373]">Withdrawals are signed on your host machine. Your host key stays with you.</p><Link href="/docs" className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-[#0D0D0D]">Host documentation <ExternalLink size={12} /></Link></div>
            <Link href="/network" className="flex items-center justify-between px-1 text-xs text-[#737373]">Explore the network <ArrowUpRight size={14} /></Link>
          </aside>
        </div>
      </main>
    </div>
  );
}
