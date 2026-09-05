"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MockBanner, useMock } from "../components/mock";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:4021";

const GPUS = [
  { id: "rtx-3090", label: "RTX 3090 · 24GB", reqDay: 6000 },
  { id: "a10g", label: "A10G · 24GB", reqDay: 9000 },
  { id: "mac-studio", label: "Mac Studio · 64GB", reqDay: 4000 },
  { id: "cpu", label: "CPU only (join demo)", reqDay: 400 },
];

export default function HostPage() {
  const [mock, toggleMock] = useMock();
  const [gpu, setGpu] = useState(GPUS[1]);
  const [duty, setDuty] = useState(5);
  const [median, setMedian] = useState<number | null>(null);

  useEffect(() => {
    if (mock) return;
    (async () => {
      try {
        const m: any = await (await fetch(`${GATEWAY}/v1/models`)).json();
        const mins = (m.data ?? [])
          .map((x: any) => BigInt(x.minPricePerReq ?? 0))
          .filter((p: bigint) => p > BigInt(0))
          .sort((a: bigint, b: bigint) => (a < b ? -1 : 1));
        if (mins.length) setMedian(Number(mins[Math.floor(mins.length / 2)]));
      } catch {}
    })();
  }, [mock]);

  // credits math: 1 credit = 1e5 delivered units (testnet REFUND_RATE), $0.001 by definition.
  const priceCredits = mock ? 1.5 : median === null ? null : median / 100000;
  const monthlyReq = (gpu.reqDay * duty) / 5;
  const gross = priceCredits === null ? null : (monthlyReq * 30 * priceCredits * 0.001);
  const take = gross === null ? null : gross * 0.9;

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      {mock && <MockBanner onOff={toggleMock} />}
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
          <Link href="/" className="text-[18px] font-semibold">Truly<span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span></Link>
          <nav className="flex items-center gap-6 text-sm font-medium text-[#6E6E73]">
            <Link href="/chat" className="hover:text-black">Chat</Link>
            <Link href="/network" className="hover:text-black">Network</Link>
            <span className="text-black">Serve</span>
          </nav>
          <button onClick={toggleMock} className="font-mono text-xs text-[#6E6E73] underline">{mock ? "show real data" : "preview with mock data"}</button>
        </div>
      </header>

      <main className="mx-auto flex max-w-[920px] flex-col gap-10 px-6 py-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="m-0 text-[34px] font-normal tracking-[-0.025em]">Turn idle GPUs into earnings</h1>
          <p className="m-0 max-w-[560px] text-[#5D5D5D]">Run a model, stake, get routed paid calls. Hosts keep 90% of every request. Leave anytime.</p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            ["1 · Run", "One compose file: Ollama + payment guard. CPU works, GPUs earn."],
            ["2 · Stake", "10 HBAR stake on testnet. It unlocks after a timelock when you leave."],
            ["3 · Earn", "90% of every routed call, withdrawable onchain. No platform rent."],
          ].map(([t, d]) => (
            <div key={t} className="flex flex-col gap-2 rounded-[14px] border border-[#E5E5E0] p-5">
              <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">{t}</span>
              <p className="m-0 text-sm leading-relaxed">{d}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 items-center gap-8 rounded-[14px] border border-[#E5E5E0] p-8 md:grid-cols-2">
          <div className="flex flex-col gap-4">
            <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Earnings estimator</span>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[#6E6E73]">Hardware</span>
              <select value={gpu.id} onChange={(e) => setGpu(GPUS.find((g) => g.id === e.target.value) ?? GPUS[0])} className="h-10 rounded-lg border border-black/10 bg-white px-3">
                {GPUS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="flex justify-between text-[#6E6E73]"><span>Duty cycle</span><span className="font-mono text-black">{duty}%</span></span>
              <input type="range" min={1} max={100} value={duty} onChange={(e) => setDuty(Number(e.target.value))} className="w-full accent-black" />
            </label>
            <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">Estimated earning, not guaranteed — varies while the network bootstraps.</p>
          </div>
          <div className="flex flex-col gap-2 border-[#E5E5E0] md:border-l md:pl-8">
            <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Your take, 30 days</span>
            <span className="font-mono text-[40px] tracking-[-0.03em] text-[#0B7A5D]">{take === null ? "—" : `$${take.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</span>
            <span className="font-mono text-xs text-[#6E6E73]">{monthlyReq.toLocaleString("en-US")} req/mo · {priceCredits === null ? "price unknown yet" : `$${(priceCredits * 0.001).toFixed(4)}/req`} · 90% share</span>
            <Link href="/host/setup" className="mt-2 flex h-10 items-center justify-center rounded-full bg-black text-sm text-white hover:bg-zinc-800">Set up this host</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
