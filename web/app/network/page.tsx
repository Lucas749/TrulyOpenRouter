"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, CircleCheck, Clock, Cpu, ExternalLink, Receipt as ReceiptIcon, Server } from "lucide-react";
import { MockBanner, useMock } from "../components/mock";
import { MOCK_HOSTS, type MockHost } from "../../lib/mock";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:4021";

interface Host {
  address: string;
  endpoint: string;
  modelId: string;
  pricePerReq: string;
  pricePer1kTokens: string;
  stake: string;
  active: boolean;
  calls24h: number;
  fail24h: number;
  reliability: number | null;
  region: string | null;
  latencyMs: number | null;
}

interface Receipt {
  id: string;
  host: string;
  priceWei: string;
  latencyMs: number;
  amountCredits?: string;
  modelId?: string;
  ts: number;
}

const short = (s: string, n = 6) => (s && s.length > n + 1 ? `${s.slice(0, n)}…` : (s ?? "—"));

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-[#10A37F]" : "bg-[#DC2626]"}`} />
      {active ? "serving" : "offline"}
    </span>
  );
}

export default function NetworkPage() {
  const [mock, toggleMock] = useMock();
  const [tab, setTab] = useState<"hosts" | "live" | "receipts">("hosts");
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);

  useEffect(() => {
    if (mock) return;
    let live = true;
    (async () => {
      try {
        const h: any = await (await fetch(`${GATEWAY}/api/hosts`)).json();
        const r: any = await (await fetch(`${GATEWAY}/api/receipts?limit=50`)).json();
        if (!live) return;
        setHosts(h.data ?? []);
        setReceipts(r.data ?? []);
      } catch {
        /* gateway down: skeletons stay */
      }
    })();
    const t = setInterval(async () => {
      try {
        const r: any = await (await fetch(`${GATEWAY}/api/receipts?limit=50`)).json();
        if (live) setReceipts(r.data ?? []);
      } catch {}
    }, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [mock]);

  const shownHosts: (Host | MockHost)[] = mock ? MOCK_HOSTS : (hosts ?? []);
  const shownReceipts = mock
    ? [
        { id: "9f2c4be10a", host: "h-0f4c…", priceWei: "1200", latencyMs: 310, amountCredits: "2", modelId: "Llama-3.1-8B", ts: Date.now() },
        { id: "4a71d0b39c", host: "h-7b1e…", priceWei: "900", latencyMs: 288, amountCredits: "1", ts: Date.now() },
        { id: "c081ae5d22", host: "h-2d90…", priceWei: "1500", latencyMs: 402, amountCredits: "2", ts: Date.now() },
      ]
    : (receipts ?? []);

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      {mock && <MockBanner onOff={toggleMock} />}
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
          <Link href="/" className="text-[18px] font-semibold">Truly<span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span></Link>
          <nav className="flex items-center gap-6 text-sm font-medium text-[#6E6E73]">
            <Link href="/chat" className="hover:text-black">Chat</Link>
            <span className="text-black">Network</span>
            <Link href="/host" className="hover:text-black">Serve</Link>
          </nav>
          <button onClick={toggleMock} className="font-mono text-xs text-[#6E6E73] underline">{mock ? "show real data" : "preview with mock data"}</button>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Network</h1>
          <span className="font-mono text-xs text-[#8F8F8F]">Updated {new Date().toISOString().slice(11, 16)} UTC</span>
        </div>

        <div className="flex min-h-[380px] flex-col overflow-hidden rounded-[14px] border border-[#0A0E14] bg-[#0A0E14] sm:min-h-[440px]">
          <div className="flex items-center gap-2 px-[18px] pt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-[#6B7686]">◉ Live network</div>
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <p className="max-w-sm font-mono text-xs leading-relaxed text-[#6B7686]">interactive globe lands here — host nodes + settling arcs, fed by the table below {mock ? "(mock nodes)" : "(live registry)"}</p>
          </div>
          <div className="flex items-end justify-between gap-3 p-[14px_18px]">
            <div className="flex items-center gap-1.5 text-[11px] text-[#8B95A5]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#10A37F]" /> serving
              <span className="ml-2 h-1.5 w-1.5 rounded-full bg-[#D97706]" /> degraded
              <span className="ml-2 h-1.5 w-1.5 rounded-full bg-[#DC2626]" /> offline
            </div>
            <span className="font-mono text-xs text-[#E6EAF0]">{shownHosts.length} hosts · table below ↓</span>
          </div>
        </div>

        <div className="flex gap-1 rounded-full bg-[#F4F4F4] p-1 text-sm">
          {(["hosts", "live", "receipts"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-full px-4 py-1.5 capitalize ${tab === t ? "bg-white shadow-sm" : "text-[#6E6E73]"}`}>{t === "live" ? "Live calls" : t}</button>
          ))}
        </div>

        {tab === "hosts" && (
          <div className="overflow-x-auto rounded-[14px] border border-[#E5E5E0]">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[#E5E5E0] text-xs uppercase tracking-wide text-[#6E6E73]">
                  <th className="px-4 py-3 font-medium">Host</th>
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Price/req</th>
                  <th className="px-4 py-3 font-medium">24h calls</th>
                  <th className="px-4 py-3 font-medium">Reliability</th>
                  <th className="px-4 py-3 font-medium">Region</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {shownHosts.length ? (
                  shownHosts.map((h: any) => (
                    <tr key={h.address} className="border-b border-[#F4F4F4] last:border-0">
                      <td className="px-4 py-3 font-mono text-xs"><Server className="mr-1.5 inline h-3.5 w-3.5" />{short(h.address)}</td>
                      <td className="px-4 py-3"><span className="inline-flex items-center gap-1 rounded-full bg-[#F4F4F4] px-2 py-0.5 text-xs"><Cpu className="h-3 w-3" />{h.modelId}</span></td>
                      <td className="px-4 py-3 font-mono text-xs">{h.pricePerReq}</td>
                      <td className="px-4 py-3 font-mono text-xs"><Activity className="mr-1 inline h-3.5 w-3.5" />{h.calls24h ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs">{h.reliability === null || h.reliability === undefined ? "—" : `${(h.reliability * 100).toFixed(1)}%`}</td>
                      <td className="px-4 py-3 font-mono text-xs">{h.region ?? "—"}</td>
                      <td className="px-4 py-3"><StatusDot active={h.active} /></td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-[#8F8F8F]">no hosts registered yet — <Link href="/host" className="text-[#2563EB] underline">be the first to serve</Link></td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "live" && (
          <div className="flex flex-col gap-2" aria-live="polite">
            {shownReceipts.length ? (
              shownReceipts.slice(0, 20).map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#E5E5E0] px-4 py-2.5 font-mono text-xs">
                  <span className="inline-flex items-center gap-1 text-[#0B7A5D]"><CircleCheck className="h-3.5 w-3.5" /> settled</span>
                  <span>{short(r.host)} → {r.modelId ?? short(r.id, 10)}</span>
                  <span className="text-[#6E6E73]">{r.latencyMs}ms</span>
                  <a href="#" className="ml-auto inline-flex items-center gap-1 text-[#2563EB]">HashScan <ExternalLink className="h-3 w-3" /></a>
                </div>
              ))
            ) : (
              <p className="flex items-center gap-2 rounded-xl border border-dashed border-[#E5E5E0] px-4 py-8 text-sm text-[#8F8F8F]"><Clock className="h-4 w-4" /> no settled calls yet — make the first one from /chat</p>
            )}
          </div>
        )}

        {tab === "receipts" && (
          <div className="flex flex-col gap-2">
            {shownReceipts.length ? (
              shownReceipts.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#E5E5E0] px-4 py-2.5 font-mono text-xs">
                  <ReceiptIcon className="h-3.5 w-3.5 text-[#8F8F8F]" />
                  <span>{short(r.id, 10)}</span>
                  <span className="text-[#6E6E73]">{r.priceWei} wei · {r.amountCredits ?? "0"} credits</span>
                  <span className="ml-auto text-[#6E6E73]">{r.latencyMs}ms</span>
                </div>
              ))
            ) : (
              <p className="rounded-xl border border-dashed border-[#E5E5E0] px-4 py-8 text-center text-sm text-[#8F8F8F]">no receipts yet</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
