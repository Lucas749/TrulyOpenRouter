"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import LoginButton from "./components/login-button";
import { MockBanner, useMock } from "./components/mock";
import { MOCK_HOST_MATH, MOCK_HERO, MOCK_RECEIPTS, MOCK_STATS, type StatPoint } from "../lib/mock";
import { topicUrl, txUrl } from "../lib/chain";

const GATEWAY = "/api/gw"; // same-origin proxy, never localhost (browser prompt + mixed content)

function useCycle<T>(items: T[], ms: number, active: boolean): T {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setI((v) => (v + 1) % items.length), ms);
    return () => clearInterval(t);
  }, [items.length, ms, active]);
  return items[i % items.length];
}

// Indicative $10 equivalents (Sep 2026: HBAR $0.08, ETH $2,450, BTC $79k).
// Static marketing copy, not live quotes — the vault takes HBAR either way.
const SUB_PRICES = ["$10", "10 USDC", "125 HBAR", "0.0041 ETH", "0.00013 BTC"];

interface ReceiptView {
  amount: string;
  hash: string;
  host: string;
  model: string;
  latency: string;
  url: string;
}

const short = (s: string, n = 6) => (s.length > n + 1 ? `${s.slice(0, n)}…` : s);

export default function Landing() {
  const [mock, toggleMock] = useMock();
  const [stats, setStats] = useState<StatPoint[] | null>(null);
  const [receipts, setReceipts] = useState<ReceiptView[] | null>(null);
  const [hero, setHero] = useState<{ hosts: number; settled: string } | null>(null);
  const [medianWei, setMedianWei] = useState<string | null>(null);
  // Protocol constant (mirrors gateway settle.ts 9/10 split), NOT mock data.
  const HOST_SHARE_PCT = 90;
  const [reqDay, setReqDay] = useState(4000);
  const subPrice = useCycle(SUB_PRICES, 2600, true);

  useEffect(() => {
    if (mock) return;
    let live = true;
    (async () => {
      try {
        const s: any = await (await fetch(`${GATEWAY}/api/stats`)).json();
        if (!live) return;
        setHero({ hosts: s.hostsOnline ?? 0, settled: (s.settledToday ?? 0).toLocaleString("en-US") });
        setStats([
          { label: "Hosts online", value: String(s.hostsOnline ?? "—"), delta: "", note: s.regions ? `${s.regions} regions, observed from host IPs` : "regions not collected yet" },
          { label: "Models served", value: String(s.modelsServed ?? "—"), delta: "", note: "digest-pinned" },
          { label: "Requests / 24h", value: (s.requests24h ?? 0).toLocaleString("en-US"), delta: "", note: `${(s.settledToday ?? 0).toLocaleString("en-US")} settled today` },
          { label: "Avg wei / req", value: s.avgPriceWeiPerReq ?? "—", delta: "", note: "network mean, testnet units" },
          { label: "Vault balance", value: s.poolBalanceWei ? `${(BigInt(s.poolBalanceWei) / BigInt(1e15)).toString()} mℏ` : "—", delta: "", note: "HBAR held by the vault contract, testnet" },
        ]);
        const r: any = await (await fetch(`${GATEWAY}/api/receipts?limit=3`)).json();
        if (!live) return;
        setReceipts((r.data ?? []).map((x: any) => ({
          amount: `${x.priceWei} wei`,
          hash: short(String(x.id), 6) + String(x.id).slice(-4),
          host: short(String(x.host), 6),
          model: short(String(x.modelDigest), 10),
          latency: `${x.latencyMs}ms`,
          // Real proof links: vault debit tx when settled, else the audit topic.
          url: x.debitTx ? txUrl(x.debitTx) : topicUrl(),
        })));
        const m: any = await (await fetch(`${GATEWAY}/v1/models`)).json();
        if (!live) return;
        const mins = (m.data ?? []).map((x: any) => BigInt(x.minPricePerReq ?? 0)).filter((p: bigint) => p > BigInt(0)).sort((a: bigint, b: bigint) => (a < b ? -1 : 1));
        if (mins.length) setMedianWei(String(mins[Math.floor(mins.length / 2)]));
      } catch {
        /* gateway down: skeletons stay, never fake */
      }
    })();
    return () => {
      live = false;
    };
  }, [mock]);

  const shownStats = mock ? MOCK_STATS : stats;
  const shownReceipts: ReceiptView[] = mock
    ? MOCK_RECEIPTS.map((r) => ({ ...r, url: "#" }))
    : (receipts ?? []);
  const pill = mock
    ? `${MOCK_HERO.hostsServing} hosts serving now · ${MOCK_HERO.regions} regions`
    : hero
      ? `${hero.hosts} hosts serving now`
      : "connecting to network…";
  const settledLine = mock ? MOCK_HERO.settledToday : (hero?.settled ?? "—");
  // Units math: 1e5 delivered units = 1 credit = $0.001, so $ = units / 1e8.
  // (Not 1e18: our prices are delivered tinybar-ish units, not ETH wei.)
  const pricePerReq = mock ? MOCK_HOST_MATH.pricePerReq : medianWei ? Number(medianWei) / 1e8 : null;
  const gross = pricePerReq === null ? null : reqDay * pricePerReq * 30;
  const take = gross === null ? null : (gross * HOST_SHARE_PCT) / 100;

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]" style={{ letterSpacing: "-0.011em" }}>
      {mock && <MockBanner onOff={toggleMock} />}
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-6 px-6">
          <Link href="/" className="flex items-center gap-2">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0D0D0D" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="#E5E5E0" />
              <path d="M5.5 15.5h3.2c1.6 0 2.1-3 3.7-3h1.4" />
              <circle cx="6" cy="15.5" r="1.1" fill="#0D0D0D" stroke="none" />
              <circle cx="10.4" cy="13.6" r="1.1" fill="#0D0D0D" stroke="none" />
              <circle cx="17.4" cy="12.5" r="2.6" />
            </svg>
            <span className="text-[18px] font-semibold">Truly<span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span></span>
          </Link>
          <nav className="flex items-center gap-6 text-sm font-medium text-[#6E6E73]">
            <Link href="/chat" className="hover:text-black">Chat</Link>
            <Link href="/network" className="hover:text-black">Network</Link>
            <Link href="/host" className="hover:text-black">Serve</Link>
            <Link href="/docs" className="hover:text-black">Docs</Link>
          </nav>
          <div className="flex items-center gap-3">
            <LoginButton />
            <Link href="/onboarding" className="flex h-9 items-center rounded-full bg-black px-4 text-sm text-white hover:bg-zinc-800">
              Subscribe <span className="ml-2 inline-block min-w-[11ch] text-left font-mono">{subPrice}</span>
            </Link>
          </div>
        </div>
      </header>

      <section className="px-6 pb-14 pt-[88px] text-center">
        <div className="mx-auto flex max-w-[820px] flex-col items-center gap-[22px]">
          <div className="inline-flex h-7 items-center gap-2 rounded-full border border-[#E5E5E0] px-3 text-xs text-[#6E6E73]">
            <span className="relative inline-flex h-[7px] w-[7px]">
              <span className="absolute inset-0 rounded-full bg-[#10A37F]" />
              <span className="absolute -inset-[3px] animate-ping rounded-full bg-[#10A37F]" />
            </span>
            <span className="font-mono">{pill}</span>
          </div>
          <h1 className="m-0 text-balance text-[66px] font-normal leading-[1.03] tracking-[-0.032em]">Like OpenRouter, except open.</h1>
          <p className="m-0 max-w-[620px] text-lg leading-relaxed text-[#5D5D5D]">One flat subscription routes your prompts across independently operated hosts running open models. Hosts keep 90% of every call. Every call settles onchain with a receipt you can check yourself.</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/onboarding" className="flex h-12 items-center rounded-full bg-black px-6 text-white hover:bg-zinc-800">
              Subscribe <span className="ml-2 inline-block min-w-[11ch] text-left font-mono">{subPrice}</span>
            </Link>
            <Link href="/host" className="flex h-12 items-center rounded-full border border-black/10 px-6 hover:bg-black/5">Serve a model</Link>
          </div>
          <p className="-mt-1 text-[13px] text-[#8F8F8F]">Crypto only, same flat month.</p>
          <p className="m-0 font-mono text-[13px] text-[#6E6E73]">{settledLine} calls settled today, <Link href="/network" className="text-[#2563EB]">verify any of them ↗</Link></p>
        </div>
      </section>

      <section className="px-6 pb-[72px]">
        <div className="mx-auto grid max-w-[1200px] grid-cols-1 items-stretch gap-6 lg:grid-cols-[1.12fr_0.88fr]">
          <Link href="/chat" className="flex flex-col overflow-hidden rounded-[14px] border border-[#E5E5E0] bg-white shadow-[0_24px_48px_-28px_rgba(0,0,0,0.18)]">
            <div className="flex items-center justify-between border-b border-[#E5E5E0] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 items-center rounded-full border border-[#E5E5E0] bg-[#F7F7F5] px-2.5 text-xs text-[#424242]">▦ Llama-3.1-8B</span>
                <span className="font-mono text-xs text-[#6E6E73]">{mock ? "$0.0015/req · 310ms" : "illustration, live prices on /network"}</span>
              </div>
              <span className="text-xs text-[#8F8F8F]">host h-0f4c…</span>
            </div>
            <div className="flex flex-1 flex-col gap-4 p-4 pt-5">
              <div className="max-w-[78%] self-end rounded-[18px_18px_4px_18px] bg-[#F4F4F4] px-3.5 py-2.5 text-sm">Summarise this contract clause in two sentences.</div>
              <p className="text-sm leading-relaxed">The clause caps liability at fees paid in the prior twelve months and excludes indirect damages. Termination for convenience requires thirty days&apos; written notice.</p>
              {mock ? (
                <div className="inline-flex items-center gap-2 self-start rounded-full bg-[#E7F5EE] px-2.5 font-mono text-xs text-[#0B7A5D]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#10A37F]" /> ✓ settled $0.0012 · 9f2c… <span className="inline-flex">↗</span>
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 self-start rounded-full bg-[#F4F4F4] px-2.5 font-mono text-xs text-[#6E6E73]">
                  illustration, real receipts settle onchain
                </div>
              )}
              <div className="mt-auto flex items-center gap-2.5 rounded-[28px] border border-[#E5E5E0] py-2.5 pl-4 pr-3 shadow-sm">
                <span className="flex-1 text-sm text-[#8F8F8F]">Message any open model</span>
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#0D0D0D] text-white">↑</span>
              </div>
            </div>
          </Link>
          <Link href="/network" className="relative flex min-h-[400px] flex-col overflow-hidden rounded-[14px] border border-[#0A0E14] bg-[#0A0E14]">
            <div className="absolute left-[18px] top-4 z-[2] flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#6B7686]">◉ Live network</div>
            <div className="flex flex-1 items-center justify-center">
              <span className="font-mono text-xs text-[#6B7686]">globe ships with the network slice</span>
            </div>
            <div className="absolute inset-x-0 bottom-0 z-[2] flex items-end justify-between gap-3 bg-gradient-to-t from-[#0A0E14] to-transparent p-[14px_18px]">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[11px] text-[#8B95A5]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#10A37F]" /> serving
                  <span className="ml-2 h-1.5 w-1.5 rounded-full bg-[#D97706]" /> degraded
                  <span className="ml-2 h-1.5 w-1.5 rounded-full bg-[#DC2626]" /> offline
                </div>
                <div className="font-mono text-xs text-[#E6EAF0]">{mock ? "12 hosts · 3 regions · 40 arcs/min" : "live counts land with /network"}</div>
              </div>
              <span className="text-xs text-[#7FB2FF]">Open explorer ↗</span>
            </div>
          </Link>
        </div>
      </section>

      <section className="border-y border-[#E5E5E0] bg-[#F7F7F5] px-6 py-9">
        <div className="mx-auto grid max-w-[1200px] grid-cols-2 gap-6 md:grid-cols-5">
          {(shownStats ?? Array.from({ length: 5 })).map((s: any, i: number) =>
            s ? (
              <div key={i} className="flex flex-col gap-2">
                <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">{s.label}</div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[28px] tracking-[-0.02em]">{s.value}</span>
                  {s.delta ? <span className="font-mono text-xs text-[#0B7A5D]">{s.delta}</span> : null}
                </div>
                <div className="text-xs text-[#8F8F8F]">{s.note}</div>
              </div>
            ) : (
              <div key={i} className="flex animate-pulse flex-col gap-2.5">
                <div className="h-2.5 w-2/3 rounded-full bg-[#ECECEC]" />
                <div className="h-[26px] w-1/2 rounded-md bg-[#ECECEC]" />
              </div>
            ),
          )}
        </div>
      </section>

      <section className="px-6 py-[88px]">
        <div className="mx-auto flex max-w-[1120px] flex-col gap-10">
          <div className="flex flex-col items-center gap-2.5 text-center">
            <h2 className="m-0 text-[34px] font-normal tracking-[-0.025em]">Subscription on the outside, x402 on the inside</h2>
            <p className="m-0 max-w-[560px] text-[#5D5D5D]">You pay once a month. Underneath, each call is a signed micropayment to whichever host wins the route. You never touch x402, it only moves between the router and hosts.</p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {[
              { n: "01 · Pool", t: "Ten dollars in, credits out", d: "Your subscription funds a shared pool held by the vault contract. No per-token invoices, no card on file with a dozen providers.", f: "$10.00/mo = 10,000 credits" },
              { n: "02 · Route", t: "Cheapest healthy host wins", d: "The router scores price, latency and stake, then pays the winner with an x402 micropayment. A host that stops answering drops out mid-flight.", f: "price scored live, per request" },
              { n: "03 · Prove", t: "Every call leaves a receipt", d: "Price, host, model digest and prompt hashes settle onchain. Prompt and completion bodies never do, only their hashes.", f: "receipts verifiable on HashScan" },
            ].map((c) => (
              <div key={c.n} className="flex flex-col gap-3 rounded-[14px] border border-[#E5E5E0] p-[26px]">
                <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">{c.n}</div>
                <h3 className="m-0 text-[17px] font-medium">{c.t}</h3>
                <p className="m-0 text-sm leading-relaxed text-[#5D5D5D]">{c.d}</p>
                <div className="mt-1 font-mono text-xs text-[#6E6E73]">{c.f}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-[#E5E5E0] bg-[#F7F7F5] px-6 py-16">
        <div className="mx-auto flex max-w-[1120px] flex-col gap-6">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 className="m-0 text-[22px] font-medium tracking-[-0.02em]">Latest settled calls</h2>
            <span className="font-mono text-xs text-[#8F8F8F]">Updated {new Date().toISOString().slice(11, 16)} UTC</span>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {shownReceipts.length ? (
              shownReceipts.map((r) => (
                <div key={r.hash} className="flex flex-col gap-3 rounded-xl border border-[#E5E5E0] bg-white p-4">
                  <div className="inline-flex h-6 items-center gap-2 self-start rounded-full bg-[#E7F5EE] px-2.5 font-mono text-xs text-[#0B7A5D]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#10A37F]" /> ✓ settled {r.amount}
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[13px]">
                    # {r.hash}
                    <a href={r.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-[#2563EB]">HashScan ↗</a>
                  </div>
                  <div className="flex items-center gap-2.5 text-xs text-[#6E6E73]">
                    <span>▦ {r.host}</span>
                    <span>▣ {r.model}</span>
                    <span className="ml-auto font-mono">{r.latency}</span>
                  </div>
                </div>
              ))
            ) : (
              <p className="font-mono text-xs text-[#8F8F8F]">no settled calls yet, be the first</p>
            )}
          </div>
        </div>
      </section>

      <section className="px-6 py-[88px]">
        <div className="mx-auto grid max-w-[920px] grid-cols-1 items-center gap-10 rounded-[14px] border border-[#E5E5E0] p-8 md:grid-cols-2">
          <div className="flex flex-col gap-3.5">
            <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">▦ Host math</div>
            <h2 className="m-0 text-[28px] font-normal tracking-[-0.025em]">Bring your own GPU, keep {HOST_SHARE_PCT}%</h2>
            <p className="m-0 text-sm leading-relaxed text-[#5D5D5D]">Serving Llama-3.1-8B at the network median. Drag to see what your throughput is worth at today&apos;s prices.</p>
            <label className="flex flex-col gap-2 text-[13px] text-[#6E6E73]">
              <span className="flex items-baseline justify-between"><span>Requests per day</span><span className="font-mono text-sm text-black">{reqDay.toLocaleString("en-US")} req/day</span></span>
              <input type="range" min={200} max={40000} step={200} value={reqDay} onChange={(e) => setReqDay(Number(e.target.value))} className="w-full accent-black" />
            </label>
          </div>
          <div className="flex flex-col gap-4 border-[#E5E5E0] pl-0 md:border-l md:pl-10">
            <div className="flex flex-col gap-1.5">
              <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Your take, 30 days</div>
              <div className="font-mono text-[40px] tracking-[-0.03em] text-[#0B7A5D]">{take === null ? "—" : `$${take.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</div>
            </div>
            <div className="flex flex-col gap-2 font-mono text-xs text-[#6E6E73]">
              <div className="flex justify-between"><span>gross</span><span>{gross === null ? "—" : `$${gross.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</span></div>
              <div className="flex justify-between"><span>protocol fee ({100 - HOST_SHARE_PCT}%)</span><span>{gross === null || take === null ? "—" : `$${(gross - take).toLocaleString("en-US", { maximumFractionDigits: 2 })}`}</span></div>
              <div className="flex justify-between border-t border-[#E5E5E0] pt-2 text-black"><span>price/req</span><span>{pricePerReq === null ? "—" : mock ? `$${pricePerReq.toFixed(4)}/req` : `${medianWei} wei/req`}</span></div>
            </div>
            <Link href="/host" className="flex h-10 items-center justify-center rounded-full border border-black/10 text-sm hover:bg-black/5">Serve a model</Link>
            {!mock && <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">testnet units until mainnet pricing</p>}
          </div>
        </div>
      </section>

      <footer className="border-t border-[#E5E5E0] bg-[#F7F7F5] px-6 pb-16 pt-14">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-10">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div className="flex flex-col gap-2.5">
              <span className="text-[19px] font-semibold">Truly<span className="text-base font-normal text-[#8F8F8F]">OpenRouter</span></span>
              <p className="m-0 max-w-[260px] text-[13px] leading-relaxed text-[#6E6E73]">Like OpenRouter, except open. Open models, independent hosts, verifiable settlement. {mock ? "Figures on this page are mock data." : "Figures on this page are live testnet data."}</p>
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Product</div>
              <Link href="/chat" className="text-[13px] text-[#2563EB]">Chat</Link>
              <Link href="/network" className="text-[13px] text-[#2563EB]">Network explorer</Link>
              <Link href="/host" className="text-[13px] text-[#2563EB]">Host dashboard</Link>
              <Link href="/team" className="text-[13px] text-[#2563EB]">Team pools</Link>
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Build</div>
              <a href="https://github.com/Lucas749/TrulyOpenRouter" className="text-[13px] text-[#2563EB]">Repository ↗</a>
              <a href="https://github.com/Lucas749/TrulyOpenRouter/blob/main/host-runner/README.md" className="text-[13px] text-[#2563EB]">SELF-HOST.md ↗</a>
              <Link href="/docs" className="text-[13px] text-[#2563EB]">API docs</Link>
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Built with</div>
              <span className="text-[13px] text-[#6E6E73]">Hedera</span>
              <span className="text-[13px] text-[#6E6E73]">Privy</span>
              <span className="text-[13px] text-[#6E6E73]">Ledger</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-[#E5E5E0] pt-6 text-xs text-[#8F8F8F]">
            <span>TrulyOpenRouter · {mock ? "figures on this page are mock data" : "figures on this page are live testnet data"}</span>
            <button onClick={toggleMock} className="font-mono underline">{mock ? "show real data" : "preview with mock data"}</button>
            <span className="font-mono">{mock ? "vault 0.0.4915‑2f · 90/10 split" : "vault 0x6cb7…f8f6 · 90/10 split"}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
