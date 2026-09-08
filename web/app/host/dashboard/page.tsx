"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

const GATEWAY = "/api/gw"; // same-origin proxy, never localhost (browser prompt + mixed content)
const CLAIM_KEY = "tor-my-hosts";

export function loadClaimed(): string[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(CLAIM_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveClaimed(list: string[]) {
  try {
    window.localStorage.setItem(CLAIM_KEY, JSON.stringify(list));
  } catch {}
}

// Stake lifecycle runs where the host key lives (CLI), never in the browser:
// copy-paste commands with the exact address filled in.
function StakeCmds({ address, active }: { address: string; active: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const cmds: [string, string][] = active
    ? [["Deregister", `cast send 0xa45461bdefef422a81b22f36ebfd0995c7642dc3 "deregister()" --rpc-url https://testnet.hashio.io/api --private-key <your-host-key>  # stake unlocks after timelock, release via /security tap`]]
    : [["Release stake", `cast send 0xa45461bdefef422a81b22f36ebfd0995c7642dc3 "release()" --rpc-url https://testnet.hashio.io/api --private-key <your-host-key>  # only after deregister + timelock`]];
  return (
    <>
      {cmds.map(([label, cmd]) => (
        <button
          key={label}
          onClick={() => {
            try {
              navigator.clipboard?.writeText(cmd).catch(() => {});
            } catch {}
            setCopied(label);
            setTimeout(() => setCopied(null), 1600);
          }}
          title={cmd}
          className="rounded-full border border-black/10 px-3 py-1 font-mono text-[11px] hover:bg-black/5"
        >
          {copied === label ? "copied ✓ (swap in your key)" : label}
        </button>
      ))}
      <span className="font-mono text-[10px] text-[#8F8F8F]">host key never leaves your machine</span>
    </>
  );
}

export default function HostDashboardPage() {
  const { user } = usePrivy();
  const userId = user?.id ?? null;
  const [addrs, setAddrs] = useState<string[] | null>(null);
  const [detail, setDetail] = useState<any[]>([]);
  const [lookup, setLookup] = useState("");
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);

  async function refresh(list: string[]) {
    setAddrs(list);
    const out: any[] = [];
    for (const a of list) {
      try {
        out.push(await (await fetch(`${GATEWAY}/api/hosts/${a}`)).json());
      } catch {}
    }
    setDetail(out);
  }

  useEffect(() => {
    (async () => {
      // Logged-in hosts (claimed via `tor-host login` + `tor-host link`,
      // visible in any browser) merged over this-browser bookmarks.
      const local = loadClaimed();
      if (userId) {
        try {
          const d: any = await (await fetch(`${GATEWAY}/api/owners/${encodeURIComponent(userId)}/hosts`)).json();
          const owned: string[] = Array.isArray(d.data) ? d.data : [];
          const merged = [...owned, ...local.filter((a) => !owned.includes(a))];
          if (merged.length !== local.length) saveClaimed(merged);
          await refresh(merged);
          return;
        } catch {}
      }
      await refresh(local);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function track() {
    const addr = lookup.trim();
    setLookupMsg(null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setLookupMsg("that doesn't look like a host address (0x + 40 hex)");
      return;
    }
    try {
      const d: any = await (await fetch(`${GATEWAY}/api/hosts/${addr}`)).json();
      if (d.error || d.registeredAt === 0) throw new Error();
    } catch {
      setLookupMsg("no registered host at that address, check /network");
      return;
    }
    const list = loadClaimed();
    if (!list.includes(addr)) {
      const next = [...list, addr];
      saveClaimed(next);
      await refresh(next);
    }
    setLookup("");
    setLookupMsg("tracking ✓");
  }

  const totalEarned = detail.reduce((a, d) => a + BigInt(d.earningsWei ?? 0), BigInt(0));

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
          <Link href="/host" className="text-sm text-[#6E6E73] hover:text-black">← Serve</Link>
          <span className="text-[15px] font-semibold">My hosts</span>
          <Link href="/host" className="text-sm text-[#2563EB] underline">+ register</Link>
        </div>
      </header>
      <main className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-8">
        {!addrs ? (
          <div className="h-24 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
        ) : !addrs.length ? (
          <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-14 text-center">
            <p className="m-0 max-w-md text-sm leading-relaxed text-[#6E6E73]">
              {userId ? (
                <>No hosts linked to this account yet, on your host machine run <span className="font-mono text-black">tor-host login</span> then <span className="font-mono text-black">tor-host link</span>, and they appear here in any browser.</>
              ) : (
                <>Log in to see your linked hosts anywhere, or paste an address to track it in this browser. Serving itself needs no account, every host is already public on <Link href="/network" className="text-[#2563EB] underline">/network</Link>.</>
              )}
            </p>
            <div className="flex w-full max-w-md gap-2">
              <input
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && track()}
                placeholder="0x host address"
                className="h-10 flex-1 rounded-lg border border-black/10 bg-white px-3 font-mono text-[13px]"
                spellCheck={false}
              />
              <button onClick={track} className="h-10 rounded-full bg-black px-5 text-sm text-white">Track</button>
            </div>
            {lookupMsg && <p className="m-0 font-mono text-xs text-[#6E6E73]">{lookupMsg}</p>}
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[13px]">
              <Link href="/host" className="rounded-full bg-black px-5 py-2.5 text-sm text-white">Register your first host</Link>
              <Link href="/host/link" className="self-center text-[#2563EB] underline">or claim via CLI code →</Link>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-6 rounded-[14px] border border-[#E5E5E0] p-5">
              <div><div className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">Withdrawable earnings</div>
                <div className="font-mono text-[28px]">{totalEarned.toString()} <span className="text-sm text-[#6E6E73]">units</span></div></div>
              <p className="m-0 max-w-md font-mono text-[11px] leading-relaxed text-[#8F8F8F]">withdrawals need the host key, run <span className="text-black">cast send … withdraw()</span> where the key lives (Ledger-tapped over threshold). In-app withdraw lands with the security slice.</p>
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
                    {d.challenged ? <span className="text-[#DC2626]">CHALLENGED, under review</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border-t border-[#E5E5E0] pt-3">
                    <StakeCmds address={d.address} active={d.active} />
                    <a href={`/network/host/${d.address}`} className="ml-auto font-mono text-[11px] text-[#2563EB] underline">receipts →</a>
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
