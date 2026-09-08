"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

const GATEWAY = "/api/gw"; // same-origin proxy, never localhost (browser prompt + mixed content)

interface Receipt {
  id: string;
  modelId?: string;
  host: string;
  priceWei: string;
  latencyMs: number;
  amountCredits?: string;
  ts: number;
  user?: string;
}

const short = (s: string, n = 6) => (s && s.length > n + 1 ? `${s.slice(0, n)}…` : (s ?? "—"));

export default function UsagePage() {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const [filter, setFilter] = useState<"wallet" | "keys">("wallet");
  const [rows, setRows] = useState<Receipt[] | null>(null);
  const [keyCount, setKeyCount] = useState<Record<string, number>>({});

  const address = user?.wallet?.address ?? wallets[0]?.address;

  useEffect(() => {
    (async () => {
      try {
        const keys: { prefix: string }[] = JSON.parse(window.localStorage.getItem("tor-keys") ?? "[]");
        const counts: Record<string, number> = {};
        for (const k of keys) {
          try {
            const r: any = await (await fetch(`${GATEWAY}/api/users/key:${k.prefix}/receipts`)).json();
            counts[k.prefix] = (r.data ?? []).length;
          } catch {}
        }
        setKeyCount(counts);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!address || filter !== "wallet") {
      setRows(null);
      return;
    }
    // Wallet-linked history: receipts attributed to this wallet's chats resolve here once
    // web chat attaches the wallet identity (today: web chats bill as shared dev quota).
    (async () => {
      try {
        const r: any = await (await fetch(`${GATEWAY}/api/users/${address}/receipts`)).json();
        setRows(r.data ?? []);
      } catch {
        setRows([]);
      }
    })();
  }, [address, filter]);

  const keyRows = Object.entries(keyCount);

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/account" className="text-sm text-[#6E6E73] hover:text-black">← Account</Link>
          <span className="text-[15px] font-semibold">Usage</span>
          <span className="w-16" />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-4 px-6 py-8">
        <div className="flex gap-1 rounded-full bg-[#F4F4F4] p-1 text-sm">
          {(["wallet", "keys"] as const).map((t) => (
            <button key={t} onClick={() => setFilter(t)} className={`flex-1 rounded-full px-4 py-1.5 capitalize ${filter === t ? "bg-white shadow-sm" : "text-[#6E6E73]"}`}>
              {t === "wallet" ? "Wallet chats" : "API keys"}
            </button>
          ))}
        </div>

        {filter === "wallet" && (
          <>
            {!ready ? (
              <div className="h-24 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
            ) : !authenticated ? (
              <p className="rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-10 text-center text-sm text-[#8F8F8F]">log in on the account page to see wallet-attributed history</p>
            ) : rows === null ? (
              <div className="h-24 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
            ) : rows.length ? (
              rows.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#E5E5E0] px-4 py-2.5 font-mono text-xs">
                  <span className="text-[#0B7A5D]">✓ {r.id.slice(0, 12)}…</span>
                  <span>{r.modelId ?? "model"}</span>
                  <span className="text-[#6E6E73]">{r.amountCredits ?? "?"} credits · {r.latencyMs}ms</span>
                  <span className="ml-auto text-[#8F8F8F]">{new Date(r.ts).toISOString().slice(5, 16).replace("T", " ")}</span>
                </div>
              ))
            ) : (
              <p className="rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-10 text-center text-sm text-[#8F8F8F]">
                no wallet-attributed calls yet, web chats currently bill shared dev quota (wallet
                identity attaches next); per-key usage is under API keys
              </p>
            )}
          </>
        )}

        {filter === "keys" && (
          <>
            {keyRows.length ? (
              keyRows.map(([prefix, n]) => (
                <div key={prefix} className="flex items-center gap-3 rounded-xl border border-[#E5E5E0] px-4 py-2.5 font-mono text-xs">
                  <span>{prefix}…</span>
                  <span className="ml-auto text-[#6E6E73]">{n} calls</span>
                  <Link href="/api" className="text-[#2563EB] underline">manage →</Link>
                </div>
              ))
            ) : (
              <p className="rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-10 text-center text-sm text-[#8F8F8F]">
                no API keys in this browser, <Link href="/api" className="text-[#2563EB] underline">create one</Link>
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
