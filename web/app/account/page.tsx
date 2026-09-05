"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, http, parseAbi } from "viem";
import { hederaTestnet } from "../../lib/hedera-chains";
import LoginButton from "../components/login-button";

const VAULT = "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576";
const VAULT_ABI = parseAbi(["function credits(address) view returns (uint256)"]);

export default function AccountPage() {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const [hbar, setHbar] = useState<string | null>(null);
  const [credits, setCredits] = useState<string | null>(null);

  const address = (user?.wallet?.address ?? wallets[0]?.address) as `0x${string}` | undefined;

  useEffect(() => {
    if (!address) return;
    (async () => {
      try {
        const client = createPublicClient({ chain: hederaTestnet, transport: http() });
        const [b, c] = await Promise.all([
          client.getBalance({ address }),
          client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "credits", args: [address] }),
        ]);
        setHbar((Number(b) / 1e18).toFixed(4));
        setCredits(String(c));
      } catch {}
    })();
  }, [address]);

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/" className="text-[18px] font-semibold">Truly<span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span></Link>
          <LoginButton />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-10">
        <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Account</h1>
        {!ready ? (
          <div className="h-32 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
        ) : !authenticated ? (
          <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-12 text-center">
            <p className="m-0 text-sm text-[#6E6E73]">log in to see your wallet, balance and credits</p>
            <LoginButton />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {[
                ["WALLET", address ? `${address.slice(0, 10)}…` : "—"],
                ["HBAR · testnet", hbar ?? "—"],
                ["CREDITS", credits ?? "—"],
              ].map(([l, v]) => (
                <div key={l} className="flex flex-col gap-1 rounded-[14px] border border-[#E5E5E0] p-4">
                  <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">{l}</span>
                  <span className="font-mono text-lg">{v}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-3">
              <Link href="/onboarding" className="flex h-10 flex-1 items-center justify-center rounded-full bg-black text-sm text-white">Top up $10</Link>
              <Link href="/api" className="flex h-10 flex-1 items-center justify-center rounded-full border border-black/10 text-sm">API keys</Link>
            </div>
            <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">balances read live from Hedera testnet (relay + vault {VAULT.slice(0, 10)}…)</p>
          </>
        )}
      </main>
    </div>
  );
}
