"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { MockBanner, useMock } from "../../components/mock";
import { MOCK_HOSTS } from "../../../lib/mock";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:4021";

export default function HostDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const [mock, toggleMock] = useMock();
  const [d, setD] = useState<any | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (mock) {
      const m = MOCK_HOSTS.find((h) => h.address.toLowerCase() === address.toLowerCase());
      if (m) setD({ ...m, lastHeartbeat: 0, challenged: false, earningsWei: null, receipts: [] });
      else setMissing(true);
      return;
    }
    (async () => {
      try {
        const r = await fetch(`${GATEWAY}/api/hosts/${address}`);
        if (r.status === 404) setMissing(true);
        else setD(await r.json());
      } catch {}
    })();
  }, [mock, address]);

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      {mock && <MockBanner onOff={toggleMock} />}
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[920px] items-center justify-between px-6">
          <Link href="/network" className="text-sm text-[#6E6E73] hover:text-black">← Network</Link>
          <span className="font-mono text-sm">{address.slice(0, 10)}…</span>
          <button onClick={toggleMock} className="font-mono text-xs text-[#6E6E73] underline">{mock ? "real" : "mock"}</button>
        </div>
      </header>
      <main className="mx-auto flex max-w-[920px] flex-col gap-6 px-6 py-8">
        {!d && !missing && <div className="h-40 animate-pulse rounded-[14px] bg-[#F4F4F4]" />}
        {missing && <p className="rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-12 text-center text-sm text-[#8F8F8F]">unknown host — check the address or <Link href="/network" className="text-[#2563EB] underline">browse the directory</Link></p>}
        {d && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm"><span className={`h-2 w-2 rounded-full ${d.active ? "bg-[#10A37F]" : "bg-[#DC2626]"}`} />{d.active ? "serving" : "offline"}</span>
              <span className="rounded-full bg-[#F4F4F4] px-2.5 py-0.5 text-xs">{d.modelId}</span>
              {d.challenged ? <span className="rounded-full bg-[#FDECEA] px-2.5 py-0.5 text-xs text-[#B3261E]">challenged — under review</span> : null}
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {[
                ["PRICE / REQ", d.pricePerReq],
                ["PRICE / 1K", d.pricePer1kTokens],
                ["STAKE", d.stake],
                ["24H CALLS", String(d.calls24h ?? "—")],
                ["RELIABILITY", d.reliability === null || d.reliability === undefined ? "—" : `${(d.reliability * 100).toFixed(1)}%`],
                ["EARNINGS", d.earningsWei ?? "—"],
                ["REGION", d.region ?? "unreported"],
                ["MODEL DIGEST", String(d.modelDigest ?? "—").slice(0, 12) + "…"],
              ].map(([l, v]) => (
                <div key={l} className="flex flex-col gap-1 rounded-[14px] border border-[#E5E5E0] p-4">
                  <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">{l}</span>
                  <span className="break-all font-mono text-sm">{v}</span>
                </div>
              ))}
            </div>
            <div>
              <h2 className="mb-3 text-[18px] font-medium">Recent receipts</h2>
              {(d.receipts ?? []).length ? (
                <div className="flex flex-col gap-2">
                  {(d.receipts ?? []).map((r: any) => (
                    <div key={r.id} className="flex flex-wrap items-center gap-x-3 rounded-xl border border-[#E5E5E0] px-4 py-2.5 font-mono text-xs">
                      <span className="text-[#0B7A5D]">✓ {r.id.slice(0, 12)}…</span>
                      <span className="text-[#6E6E73]">{r.priceWei} wei · {(r.tokensIn ?? 0) + (r.tokensOut ?? 0)} tok · {r.latencyMs}ms</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[#8F8F8F]">no receipts recorded for this host yet</p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
