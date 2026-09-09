"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { createPublicClient, formatEther, http } from "viem";
import LoginButton from "../../components/login-button";
import { contractUrl } from "../../../lib/chain";

const RPC = "https://testnet.hashio.io/api";
const GW = "/api/gw"; // same-origin proxy, never localhost
const STAKE_HBAR = 10; // registry minimum stake, mirrored from tor-host run

function short(a: string) {
  return `${a.slice(0, 10)}…${a.slice(-4)}`;
}

function HostOnboardingInner() {
  const params = useSearchParams();
  const { ready, authenticated, user } = usePrivy();
  const account = (user?.wallet?.address ?? user?.id ?? null) as string | null;
  const [owned, setOwned] = useState<string[]>([]);
  // Hosts already claimed by this login (owner-claim at run/link time) —
  // prefill the first so returning users never paste anything.
  useEffect(() => {
    if (!authenticated || !user?.id) {
      setOwned([]);
      return;
    }
    (async () => {
      try {
        const d: any = await (await fetch(`${GW}/api/owners/${encodeURIComponent(user.id)}/hosts`)).json();
        const list: string[] = Array.isArray(d.data) ? d.data : [];
        setOwned(list);
        if (list.length > 0 && !params.get("address")) setAddr(list[0]);
      } catch {
        /* gateway down — manual input still works */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, user?.id]);
  const [addr, setAddr] = useState(params.get("address") ?? "");
  const [balance, setBalance] = useState<string | null>(null);
  const [host, setHost] = useState<any | null>(null);
  const [hostState, setHostState] = useState<"idle" | "missing" | "live">("idle");
  const [drip, setDrip] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const clean = addr.trim();
  const valid = /^0x[0-9a-fA-F]{40}$/.test(clean);

  const refresh = useCallback(async () => {
    if (!valid) return;
    setMsg(null);
    try {
      const client = createPublicClient({ transport: http(RPC) });
      const b = await client.getBalance({ address: clean as `0x${string}` });
      setBalance(formatEther(b));
    } catch {
      setBalance(null);
    }
    try {
      const r = await fetch(`${GW}/api/hosts/${clean}`);
      if (r.status === 404) {
        setHost(null);
        setHostState("missing");
      } else if (r.ok) {
        setHost(await r.json());
        setHostState("live");
      }
    } catch {
      /* gateway down — balance still shows */
    }
  }, [clean, valid]);

  useEffect(() => {
    if (valid) void refresh();
    else {
      setBalance(null);
      setHost(null);
      setHostState("idle");
    }
  }, [valid, refresh]);

  async function dripFunds() {
    if (!valid) return;
    setDrip("sending");
    setMsg(null);
    try {
      const r = await fetch("/api/account/drip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: clean }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (r.status === 409) {
        setMsg("account already exists — the drip is one per address, faucet covers the rest");
        setDrip("error");
      } else if (!r.ok) {
        throw new Error(d?.error ?? r.status);
      } else {
        setDrip("done");
        setMsg("0.5 HBAR on the way — refresh balance in ~10s, then hit the faucet for stake");
        setTimeout(refresh, 12000);
      }
    } catch (e: any) {
      setDrip("error");
      setMsg(`drip failed: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  function copy() {
    if (!valid) return;
    (navigator.clipboard?.writeText(clean) ?? Promise.reject()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setMsg("copy failed — select the address manually"),
    );
  }

  const funded = balance !== null && Number(balance) >= STAKE_HBAR;
  const step = !authenticated ? 1 : hostState === "live" ? 3 : 2;

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/host" className="text-sm text-[#6E6E73] hover:text-black">← Serve</Link>
          <span className="text-[15px] font-semibold">Become a host</span>
          <LoginButton />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-10">
        <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Serve a model, earn per request</h1>

        <section className={`rounded-[14px] border p-5 ${step === 1 ? "border-black" : "border-[#E5E5E0]"}`}>
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">1 · Login {!ready ? "" : authenticated ? "✓" : ""}</div>
          {!ready ? (
            <div className="h-8 w-40 animate-pulse rounded-full bg-[#F4F4F4]" />
          ) : authenticated ? (
            <p className="m-0 text-sm text-[#6E6E73]">
              Logged in{account ? <> as <span className="font-mono text-black">{short(account)}</span></> : null} —
              earnings and dashboard attach to this account. Your <em>host key</em> below is a
              separate machine address that pays the stake.
            </p>
          ) : (
            <>
              <p className="m-0 mb-3 text-sm text-[#6E6E73]">Email login, no seed phrase. Your host&apos;s earnings link here.</p>
              <LoginButton />
            </>
          )}
        </section>

        <section className={`rounded-[14px] border p-5 ${step === 2 ? "border-black" : "border-[#E5E5E0]"} ${!authenticated ? "opacity-50" : ""}`}>
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">
            2 · Fund your host key {funded ? "✓" : ""}
          </div>
          <p className="m-0 mb-3 font-mono text-[11px] text-[#8F8F8F]">
            two addresses: your login above receives earnings · the host key below pays stake
          </p>
          {owned.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {owned.map((a) => (
                <button
                  key={a}
                  onClick={() => setAddr(a)}
                  className={`h-9 rounded-full border px-4 font-mono text-xs ${a.toLowerCase() === clean.toLowerCase() ? "border-black bg-black text-white" : "border-black/10 hover:bg-black/5"}`}
                >
                  {short(a)}
                </button>
              ))}
            </div>
          )}
          {owned.length > 0 && valid && (
            <p className="m-0 mb-3 font-mono text-[11px] text-[#0B7A5D]">found on your account ✓</p>
          )}
          {!params.get("address") && owned.length === 0 && !valid ? (
            <div className="mb-3 rounded-lg bg-[#F7F7F5] p-3 text-sm text-[#5D5D5D]">
              No address yet? Run this once locally — it prints your host address, then come back and paste it:
              <p className="m-0 mt-2 rounded-lg bg-white p-2 font-mono text-xs">tor-host run --model qwen2.5:0.5b --endpoint https://…</p>
              <p className="m-0 mt-2 font-mono text-xs text-[#8F8F8F]">looks like 0x91c3…DCE4e (42 chars, 0x + 40 hex)</p>
            </div>
          ) : (
            <p className="m-0 mb-3 text-sm text-[#6E6E73]">
              Registration stakes {STAKE_HBAR} HBAR on Hedera testnet. Get test HBAR below, then back in your terminal.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <input
              value={addr}
              onChange={(e) => setAddr(e.target.value)}
              placeholder="host address 0x…"
              autoComplete="off"
              spellCheck={false}
              className="h-10 min-w-[240px] flex-1 rounded-lg border border-black/10 px-3 font-mono text-sm"
            />
            <button onClick={refresh} disabled={!valid} className="h-10 rounded-full border border-black/10 px-4 text-sm disabled:opacity-40">
              Check
            </button>
          </div>
          {valid && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={copy} className="h-9 rounded-full border border-black/10 px-4 font-mono text-xs">
                {copied ? "copied ✓" : `copy ${short(clean)}`}
              </button>
              <button onClick={dripFunds} disabled={drip === "sending"} className="h-9 rounded-full bg-black px-4 text-xs text-white disabled:opacity-40">
                {drip === "sending" ? "dripping…" : "Drip 0.5 HBAR"}
              </button>
              <a href="https://faucet.hedera.com" target="_blank" rel="noreferrer" className="flex h-9 items-center rounded-full border border-black/10 px-4 text-xs hover:bg-black/5">
                faucet.hedera.com ↗
              </a>
              <span className="font-mono text-sm">{balance === null ? "balance —" : `${Number(balance).toFixed(2)} HBAR`}</span>
            </div>
          )}
          {valid && balance !== null && !funded && (
            <p className="mb-0 mt-3 text-sm text-[#8A5300]">
              Needs ≥ {STAKE_HBAR} HBAR to register (drip covers account creation, the faucet covers stake).
            </p>
          )}
          {msg && <p className="mb-0 mt-3 font-mono text-xs text-[#6E6E73]">{msg}</p>}
        </section>

        <section className={`rounded-[14px] border p-5 ${step === 3 ? "border-black" : "border-[#E5E5E0]"} ${!funded || !authenticated ? "opacity-50" : ""}`}>
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">
            3 · Register {hostState === "live" ? "✓" : ""}
          </div>
          {hostState === "live" && host ? (
            <>
              <p className="m-0 mb-3 text-sm text-[#6E6E73]">
                Serving <span className="font-mono text-black">{host.modelId ?? "?"}</span>
                {host.endpoint ? <> via <span className="font-mono text-black">{String(host.endpoint).slice(0, 32)}…</span></> : null} ·
                heartbeat {host.lastHeartbeat ? `${Math.max(0, Math.round((Date.now() - host.lastHeartbeat) / 60000))}m ago` : "—"}
              </p>
              <Link href="/host/dashboard" className="inline-flex h-10 items-center rounded-full bg-black px-5 text-sm text-white hover:bg-zinc-800">
                Open dashboard
              </Link>
            </>
          ) : (
            <>
              <p className="m-0 mb-3 text-sm text-[#6E6E73]">Back in your terminal — one command registers, stakes, and claims the host for this account:</p>
              <p className="m-0 rounded-lg bg-[#F7F7F5] p-3 font-mono text-xs">tor-host run --model qwen2.5:0.5b --endpoint https://…</p>
              <button onClick={refresh} disabled={!valid} className="mt-3 h-10 rounded-full border border-black/10 px-4 text-sm disabled:opacity-40">
                Check registration
              </button>
            </>
          )}
        </section>

        <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">
          testnet only · stake unlocks on leave · <Link href="/host" className="underline">how hosting works</Link>
        </p>
      </main>
    </div>
  );
}

export default function HostOnboardingPage() {
  return (
    <Suspense>
      <HostOnboardingInner />
    </Suspense>
  );
}
