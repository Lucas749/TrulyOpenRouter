"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:4021";

export default function HostDashboardPage() {
  const [addrs, setAddrs] = useState<string[] | null>(null);
  const [detail, setDetail] = useState<any[]>([]);

  useEffect(() => {
    let list: string[] = [];
    try {
      list = JSON.parse(window.localStorage.getItem("tor-my-hosts") ?? "[]");
    } catch {}
    setAddrs(list);
    (async () => {
      const out: any[] = [];
      for (const a of list) {
        try {
          out.push(await (await fetch(`${GATEWAY}/api/hosts/${a}`)).json());
        } catch {}
      }
      setDetail(out);
    })();
  }, []);

  const totalEarned = detail.reduce((a, d) => a + BigInt(d.earningsWei ?? 0), 0n);

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
          <Link href="/host" className="text-sm text-[#6E6E73] hover:text-black">← Serve</Link>
          <span className="text-[15px] font-semibold">My hosts</span>
          <Link href="/host/setup" className="text-sm text-[#2563EB] underline">+ register</Link>
        </div>
      </header>
      <main className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-8">
        {!addrs ? (
          <div className="h-24 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
        ) : !addrs.length ? (
          <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-14 text-center">
            <p className="m-0 text-sm text-[#6E6E73]">no hosts claimed in this browser yet</p>
            <Link href="/host/setup" className="flex h-10 items-center rounded-full bg-black px-5 text-sm text-white">Register your first host</Link>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-6 rounded-[14px] border border-[#E5E5E0] p-5">
              <div><div className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">Withdrawable earnings</div>
                <div className="font-mono text-[28px]">{totalEarned.toString()} <span className="text-sm text-[#6E6E73]">units</span></div></div>
              <p className="m-0 max-w-md font-mono text-[11px] leading-relaxed text-[#8F8F8F]">withdrawals need the host key — run <span className="text-black">cast send … withdraw()</span> where the key lives (Ledger-tapped over threshold). In-app withdraw lands with the security slice.</p>
            </div>
            {detail.map((d: any) => {
              const toks = (d.receipts ?? []).reduce((a: number, r: any) => a + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
              return (
                <div key={d.address} className="flex flex-col gap-4 rounded-[14px] border border-[#E5E5E0] p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex items-center gap-1.5 text-xs`}><span className={`h-1.5 w-1.5 rounded-full ${d.active ? "bg-[#10A37F]" : "bg-[#DC2626]"}`} />{d.active ? "serving" : "offline"}</span>
                    <span className="font-mono text-xs">{d.address.slice(0, 10)}…</span>
                    <span className="rounded-full bg-[#F4F4F4] px-2 py-0.5 text-xs">{d.modelId}</span>
                    <a href={`/network/host/${d.address}`} className="ml-auto text-xs text-[#2563EB] underline">public page →</a>
                  </div>
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    {[
                      ["QUERIES · 24H", String(d.calls24h ?? "—"), `${d.fail24h ?? 0} failed`],
                      ["TOKENS · recent", toks.toLocaleString("en-US"), "last 20 receipts"],
                      ["EARNED · withdrawable", `${d.earningsWei ?? "—"}`, d.earningsWei === null ? "vault not wired" : "units"],
                      ["CHARGING", `${d.pricePerReq} /req`, `${d.pricePer1kTokens} /1k`],
                    ].map(([l, v, s]) => (
                      <div key={l} className="flex flex-col gap-1">
                        <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">{l}</span>
                        <span className="font-mono text-lg">{v}</span>
                        <span className="font-mono text-[11px] text-[#8F8F8F]">{s}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-[#8F8F8F]">
                    <span>stake {d.stake}</span>
                    <span>heartbeat {d.lastHeartbeat ? new Date(d.lastHeartbeat * 1000).toISOString().slice(11, 16) + " UTC" : "—"}</span>
                    <span>region {d.region ?? "unreported"}</span>
                    <span>reliability {d.reliability === null || d.reliability === undefined ? "—" : `${(d.reliability * 100).toFixed(1)}%`}</span>
                    {d.challenged ? <span className="text-[#DC2626]">CHALLENGED — under review</span> : null}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}
