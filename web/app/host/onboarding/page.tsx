"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { createPublicClient, formatEther, http, parseEther } from "viem";
import LoginButton from "../../components/login-button";
import { contractUrl } from "../../../lib/chain";
import { loadHostFunding } from "../../../lib/host-funding";
import HostFaucet from "./host-faucet";

const RPC = "https://testnet.hashio.io/api";
const GW = "/api/gw"; // same-origin proxy, never localhost

function short(a: string) {
  return `${a.slice(0, 10)}…${a.slice(-4)}`;
}

function HostOnboardingInner() {
  const params = useSearchParams();
  const { ready, authenticated, user } = usePrivy();
  const account = (user?.wallet?.address ?? user?.id ?? null) as string | null;
  const [owned, setOwned] = useState<string[]>([]);
  // user typed/picked manually — auto-fill never overwrites
  const touchedRef = useRef(false);
  // Hosts claimed by this login (owner-claim at CLI login time). Polled, not
  // once: the claim typically lands AFTER this page loads (login → approve →
  // claim), and the field fills itself the moment it exists. Zero pasting.
  useEffect(() => {
    if (!authenticated || !user?.id) {
      setOwned([]);
      return;
    }
    let stop = false;
    const load = async () => {
      try {
        const d: any = await (await fetch(`${GW}/api/owners/${encodeURIComponent(user.id)}/hosts`)).json();
        if (stop) return;
        const list: string[] = Array.isArray(d.data) ? d.data : [];
        setOwned(list);
        if (list.length > 0 && !params.get("address")) {
          setAddr((cur) => (touchedRef.current ? cur : list[0]));
        }
      } catch {
        /* gateway down — manual input still works */
      }
    };
    void load();
    const t = setInterval(load, 10000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, user?.id]);
  const [addr, setAddr] = useState(params.get("address") ?? "");
  const [balance, setBalance] = useState<string | null>(null);
  const [host, setHost] = useState<any | null>(null);
  const [hostState, setHostState] = useState<"idle" | "missing" | "live">("idle");
  const [drip, setDrip] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string | null>>({});
  const [checking, setChecking] = useState(false);
  const [funding, setFunding] = useState<{ stakeHbar: string; totalHbar: string } | null>(null);
  const [fundingError, setFundingError] = useState(false);
  const requestedStake = params.get("stake");
  const STAKE_HBAR = funding?.stakeHbar ?? "—";
  const NEED_HBAR = funding?.totalHbar ?? "—";

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const next = await loadHostFunding(requestedStake);
        if (!stopped) { setFunding(next); setFundingError(false); }
      } catch {
        if (!stopped) { setFunding(null); setFundingError(true); }
      }
    };
    void load();
    const timer = setInterval(load, 15000);
    return () => { stopped = true; clearInterval(timer); };
  }, [requestedStake]);

  const clean = addr.trim();
  const valid = /^0x[0-9a-fA-F]{40}$/.test(clean);
  const fromOwned = valid && owned.some((a) => a.toLowerCase() === clean.toLowerCase());
  const done = hostState === "live" && host != null;
  // Focus the selected key; the rest of the account's keys sit behind a
  // toggle (no gateway ordering guarantees, so no "latest" claims).
  const [showAll, setShowAll] = useState(false);
  const others = owned.filter((a) => a.toLowerCase() !== clean.toLowerCase());
  const visibleOwned = valid ? (showAll ? owned : []) : owned;

  // Balances for every key on this account — one row per machine below.
  useEffect(() => {
    if (owned.length === 0) {
      setBalances({});
      return;
    }
    let stop = false;
    const loadBal = async () => {
      try {
        const client = createPublicClient({ transport: http(RPC) });
        const pairs = await Promise.all(
          owned.map(async (a) => {
            try {
              const b = await client.getBalance({ address: a as `0x${string}` });
              return [a.toLowerCase(), formatEther(b)] as const;
            } catch {
              return [a.toLowerCase(), null] as const;
            }
          }),
        );
        if (!stop) setBalances(Object.fromEntries(pairs));
      } catch {
        /* offline — rows show balance — */
      }
    };
    void loadBal();
    const t = setInterval(loadBal, 15000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [owned]);

  const refresh = useCallback(async () => {
    if (!valid) return;
    setMsg(null);
    setChecking(true);
    try {
      const client = createPublicClient({ transport: http(RPC) });
      const b = await client.getBalance({ address: clean as `0x${string}` });
      setBalance(formatEther(b));
    } catch {
      setBalance(null);
    } finally {
      setChecking(false);
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

  // Your terminal registers in the background — flip to live on its own.
  useEffect(() => {
    if (!valid || hostState === "live") return;
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [valid, hostState, refresh]);

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

  // Live hosts read low (stake is locked) — done counts as funded.
  const funded = done || (funding !== null && balance !== null && parseEther(balance) >= parseEther(funding.totalHbar));
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
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">1 · Your account — uses inference, receives earnings {!ready ? "" : authenticated ? "✓" : ""}</div>
          {!ready ? (
            <div className="h-8 w-40 animate-pulse rounded-full bg-[#F4F4F4]" />
          ) : authenticated ? (
            <p className="m-0 text-sm text-[#6E6E73]">
              Logged in{account ? <> as <span className="font-mono text-black">{short(account)}</span></> : null} —
              chat credits and host earnings attach here. Serving happens below, on host keys.
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
            2 · Your host keys — serve models, pay stake {funded ? "✓" : ""}
          </div>
          <p className="m-0 mb-3 text-sm text-[#6E6E73]">
            One row per machine on this account — pick one to fund (≥ {NEED_HBAR} HBAR = {STAKE_HBAR} stake + gas reserve).
          </p>
          {fundingError && <p className="text-sm text-amber-700">Cannot check the current stake requirement. Retrying automatically.</p>}
          {visibleOwned.length > 0 && (
            <div className="mb-3 flex flex-col gap-2">
              {visibleOwned.map((a) => {
                const bal = balances[a.toLowerCase()];
                const ready = bal != null && funding !== null && parseEther(bal) >= parseEther(funding.totalHbar);
                const active = a.toLowerCase() === clean.toLowerCase();
                return (
                  <div
                    key={a}
                    className={`flex h-11 items-center gap-2 rounded-lg border px-4 ${active ? "border-black bg-black text-white" : "border-black/10"}`}
                  >
                    <button
                      onClick={() => {
                        touchedRef.current = true;
                        setAddr(a);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="truncate font-mono text-xs">{short(a)}</span>
                      <span className={`ml-auto shrink-0 font-mono text-xs ${active ? "" : ready ? "text-[#0B7A5D]" : "text-[#8A5300]"}`}>
                        {bal == null ? "balance —" : `${Number(bal).toFixed(2)} HBAR${ready ? " ✓" : ""}`}
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        (navigator.clipboard?.writeText(a) ?? Promise.reject()).then(
                          () => setMsg(`copied ${short(a)} ✓`),
                          () => setMsg("copy failed — select the address manually"),
                        );
                      }}
                      title={`copy ${a}`}
                      className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[11px] ${active ? "border-white/30 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
                    >
                      ⧉
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {valid && others.length > 0 && (
            <button onClick={() => setShowAll((s) => !s)} className="mb-3 font-mono text-[11px] text-[#6E6E73] underline">
              {showAll ? "hide" : `+${others.length} other key${others.length === 1 ? "" : "s"} on this account`}
            </button>
          )}
          {!params.get("address") && owned.length === 0 && !valid ? (
            <div className="mb-3 rounded-lg bg-[#F7F7F5] p-3 text-sm text-[#5D5D5D]">
              Nothing to paste — your quickstart terminal shows the host address when it needs
              funds, and opens this page pre-filled automatically. Different machine? Run the
              quickstart there.
              <p className="m-0 mt-2 font-mono text-xs text-[#8F8F8F]">a host address looks like 0x91c3…DCE4e (0x + 40 hex)</p>
            </div>
          ) : (
            <p className="m-0 mb-3 text-sm text-[#6E6E73]">
              Registration stakes {STAKE_HBAR} HBAR on Hedera testnet (+ ~1 gas). Get test HBAR below, then back in your terminal.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <input
              value={addr}
              onChange={(e) => {
                touchedRef.current = true;
                setAddr(e.target.value);
              }}
              placeholder="host address 0x…"
              autoComplete="off"
              spellCheck={false}
              className="h-10 min-w-[240px] flex-1 rounded-lg border border-black/10 px-3 font-mono text-sm"
            />
            <button onClick={refresh} disabled={!valid || checking} className="h-10 rounded-full border border-black/10 px-4 text-sm disabled:opacity-40">
              {checking ? "checking…" : "Check"}
            </button>
          </div>
          {valid && !done && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={dripFunds} disabled={drip === "sending"} className="h-9 rounded-full bg-black px-4 text-xs text-white disabled:opacity-40">
                {drip === "sending" ? "dripping…" : "Drip 0.5 HBAR"}
              </button>
              <a href="https://faucet.hedera.com" target="_blank" rel="noreferrer" className="flex h-9 items-center rounded-full border border-black/10 px-4 text-xs hover:bg-black/5">
                faucet.hedera.com ↗
              </a>
              <span className="font-mono text-sm">{balance === null ? "balance —" : `${Number(balance).toFixed(2)} HBAR`}</span>
            </div>
          )}
          {done && (
            <p className="mb-0 mt-3 text-sm text-[#0B7A5D]">serving ✓ — earnings flow to your login wallet</p>
          )}
          {valid && !done && <HostFaucet key={clean.toLowerCase()} address={clean} onFunded={refresh} />}
          {valid && balance !== null && !funded && (
            <p className="mb-0 mt-3 text-sm text-[#8A5300]">
              Needs ≥ {NEED_HBAR} HBAR to register. Get 5 HBAR from us, or use the Hedera faucet for stake + gas.
              {fromOwned && hostState !== "live" ? " Attached to your account ✓ — fund it, then register from your terminal." : ""}
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
              <p className="m-0 mb-3 text-sm text-[#6E6E73]">
                Waiting for your terminal — it registers, stakes, and claims automatically.
                This flips ✓ on its own, then the dashboard opens.
              </p>
              <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">
                watching {valid ? short(clean) : "…"} · rechecks every 10s
              </p>
              <button onClick={refresh} disabled={!valid || checking} className="mt-3 h-10 rounded-full border border-black/10 px-4 text-sm disabled:opacity-40">
                {checking ? "checking…" : "Check now"}
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
