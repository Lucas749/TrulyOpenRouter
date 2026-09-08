"use client";

import Link from "next/link";
import { useState } from "react";
import { useConnectWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import { hederaTestnet } from "../../lib/hedera-chains";
import LoginButton from "../components/login-button";
import { contractUrl } from "../../lib/chain";

const VAULT = "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576";
const PLAN_ID = 0;
const PLAN_PRICE_WEI = BigInt(10_000_000_000_000_000_000); // 10 HBAR sent
const PLAN_CREDITS = 10_000;
const RPC = "https://testnet.hashio.io/api";

const VAULT_ABI = parseAbi([
  "function subscribe(uint256) payable",
  "function credits(address) view returns (uint256)",
]);

export default function OnboardingPage() {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const [credits, setCredits] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const wallet = wallets[0];
  const address = (user?.wallet?.address ?? wallet?.address) as `0x${string}` | undefined;

  async function refresh() {
    if (!address) return;
    try {
      const client = createPublicClient({ transport: http(RPC) });
      const c = await client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "credits", args: [address] });
      setCredits(String(c));
    } catch {
      setMsg("could not read credits, is the wallet funded with testnet HBAR?");
    }
  }

  async function subscribe() {
    if (!authenticated) {
      setMsg("log in first (step 1) — the subscription pays from your embedded wallet");
      return;
    }
    if (!wallet || !address) {
      setMsg("wallet still being created — wait a few seconds and retry");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await wallet.switchChain(hederaTestnet.id);
      const provider = await wallet.getEthereumProvider();
      const walletClient = createWalletClient({ account: address, chain: hederaTestnet, transport: custom(provider) });
      const hash = await walletClient.writeContract({
        address: VAULT,
        abi: VAULT_ABI,
        functionName: "subscribe",
        args: [BigInt(PLAN_ID)],
        value: PLAN_PRICE_WEI,
      });
      setMsg(`subscribed ✓ ${hash.slice(0, 18)}…, reading credits…`);
      setTimeout(refresh, 4000);
    } catch (e: any) {
      setMsg(`subscribe failed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    setBusy(false);
  }

  const step = !authenticated ? 1 : credits === null || credits === "0" ? 2 : 3;

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/" className="text-[18px] font-semibold">Truly<span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span></Link>
          <LoginButton />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-10">
        <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Get started in 3 steps</h1>

        <section className={`rounded-[14px] border p-5 ${step === 1 ? "border-black" : "border-[#E5E5E0]"}`}>
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">1 · Login {!ready ? "" : authenticated ? "✓" : ""}</div>
          {!ready ? (
            <div className="h-8 w-40 animate-pulse rounded-full bg-[#F4F4F4]" />
          ) : authenticated ? (
            <p className="m-0 font-mono text-sm">{address}</p>
          ) : (
            <>
              <p className="m-0 mb-3 text-sm text-[#6E6E73]">Email login, embedded wallet, no seed phrase. Or bring your own wallet.</p>
              <div className="flex flex-wrap gap-2">
                <LoginButton />
                <button onClick={() => connectWallet()} className="flex h-10 items-center rounded-full border border-black/10 px-5 text-sm hover:bg-black/5">
                  Connect a wallet
                </button>
              </div>
            </>
          )}
        </section>

        <section className={`rounded-[14px] border p-5 ${step === 2 ? "border-black" : "border-[#E5E5E0]"} ${!authenticated ? "opacity-50" : ""}`}>
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">2 · Subscribe, $10 → {PLAN_CREDITS.toLocaleString("en-US")} credits {credits !== null && authenticated ? "✓" : ""}</div>
          <p className="m-0 mb-3 text-sm text-[#6E6E73]">
            One onchain payment on Hedera testnet. Your wallet needs testnet HBAR first —{" "}
            <a href="https://faucet.hedera.com" className="text-[#2563EB] underline">faucet.hedera.com</a>
            {address ? <>, then send to <span className="font-mono text-black">{address.slice(0, 10)}…</span></> : null}.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={subscribe} disabled={!authenticated || busy} className="flex h-10 items-center rounded-full bg-black px-5 text-sm text-white disabled:opacity-40">
              {busy ? "confirm in wallet…" : "Subscribe $10"}
            </button>
            <button onClick={refresh} disabled={!authenticated} className="h-10 rounded-full border border-black/10 px-4 text-sm disabled:opacity-40">Check credits</button>
            {credits !== null && <span className="font-mono text-sm">{credits} credits</span>}
          </div>
          {msg && <p className="mb-0 mt-3 font-mono text-xs text-[#6E6E73]">{msg}</p>}
          <p className="mb-0 mt-2 font-mono text-[11px] text-[#8F8F8F]">vault {VAULT.slice(0, 10)}… · <a href={contractUrl(VAULT)} className="underline">HashScan ↗</a></p>
        </section>

        <section className={`rounded-[14px] border p-5 ${step === 3 ? "border-black" : "border-[#E5E5E0]"} ${step < 3 ? "opacity-50" : ""}`}>
          <div className="mb-1 text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">3 · Use it</div>
          <div className="flex gap-3">
            <Link href="/chat" className="flex h-10 flex-1 items-center justify-center rounded-full bg-black text-sm text-white hover:bg-zinc-800">Chat now</Link>
            <Link href="/host" className="flex h-10 flex-1 items-center justify-center rounded-full border border-black/10 text-sm hover:bg-black/5">Serve a model</Link>
          </div>
        </section>
      </main>
    </div>
  );
}
