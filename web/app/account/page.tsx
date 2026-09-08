"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import { hederaTestnet } from "../../lib/hedera-chains";
import LoginButton from "../components/login-button";

const VAULT = "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576";
const VAULT_ABI = parseAbi([
  "function credits(address) view returns (uint256)",
  "function refund()",
]);

const MIRROR = "https://testnet.mirrornode.hedera.com";

interface VaultTx {
  id: string;
  ts: number;
  hbar: number;
  kind: string;
}

export default function AccountPage() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  const [hbar, setHbar] = useState<string | null>(null);
  const [credits, setCredits] = useState<string | null>(null);
  const [reqCount, setReqCount] = useState<number | null>(null);
  const [paidUsd, setPaidUsd] = useState<number | null>(null);
  const [recentCalls, setRecentCalls] = useState<any[]>([]);
  const [vaultTxs, setVaultTxs] = useState<VaultTx[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const address = (user?.wallet?.address ?? wallets[0]?.address) as `0x${string}` | undefined;
  const [hederaId, setHederaId] = useState<string | null>(null);

  async function refund() {
    const w = wallets[0];
    if (!w || !address) return;
    setBusy(true);
    setMsg(null);
    try {
      await w.switchChain(hederaTestnet.id);
      const provider = await w.getEthereumProvider();
      const walletClient = createWalletClient({ account: address, chain: hederaTestnet, transport: custom(provider) });
      const hash = await walletClient.writeContract({ address: VAULT, abi: VAULT_ABI, functionName: "refund" });
      setMsg(`refunded ✓ ${hash.slice(0, 18)}…, unused credits back as HBAR`);
    } catch (e: any) {
      setMsg(`refund failed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    setBusy(false);
  }

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
      // Usage: receipts attributed to this wallet (chat sends the handle when logged in).
      try {
        const r: any = await (await fetch(`/api/gw/api/users/wallet:${address}/receipts`)).json();
        const mine: any[] = r.data ?? [];
        setReqCount(mine.length);
        setPaidUsd(mine.reduce((a: number, x: any) => a + Number(x.amountCredits ?? 0) * 0.001, 0));
        setRecentCalls(mine.slice(0, 5));
      } catch {
        setReqCount(null);
        setPaidUsd(null);
      }
      // Hedera account id for this EVM key (mirror lookup; null until funded).
      try {
        const a: any = await (await fetch(`${MIRROR}/api/v1/accounts/${address}`)).json();
        if (a.account) setHederaId(String(a.account));
      } catch {}
      // Last onchain vault payments (mirror node contract results, newest first).
      try {
        const d: any = await (
          await fetch(`${MIRROR}/api/v1/contracts/${VAULT}/results?from=${address}&limit=5&order=desc`)
        ).json();
        setVaultTxs(
          (d.results ?? []).map((t: any) => ({
            id: String(t.transaction_id),
            ts: Number(String(t.consensus_timestamp).split(".")[0]) * 1000,
            hbar: Number(t.amount ?? 0) / 1e8,
            kind: Number(t.amount ?? 0) > 0 ? "subscribe" : "call",
          })),
        );
      } catch {
        setVaultTxs(null);
      }
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
            <div className="flex flex-wrap items-center gap-3">
              {credits === null ? (
                <span className="font-mono text-xs text-[#8F8F8F]">subscription status unknown</span>
              ) : Number(credits) > 0 ? (
                <span className="rounded-full bg-[#E7F5EE] px-3 py-1 text-xs font-medium text-[#0B7A5D]">Subscription active · {credits} credits left</span>
              ) : (
                <span className="rounded-full bg-[#FDF3E2] px-3 py-1 text-xs font-medium text-[#8A5300]">Out of credits — top up to keep chatting settled</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {[
                ["REQUESTS", reqCount === null ? "—" : String(reqCount)],
                ["PAID · metered", paidUsd === null ? "—" : `$${paidUsd.toFixed(3)}`],
                ["HBAR · testnet", hbar ?? "—"],
                ["CREDITS", credits ?? "—"],
              ].map(([l, v]) => (
                <div key={l} className="flex flex-col gap-1 rounded-[14px] border border-[#E5E5E0] p-4">
                  <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">{l}</span>
                  <span className="font-mono text-lg">{v}</span>
                </div>
              ))}
            </div>
              <div className="flex flex-col gap-1.5 rounded-[14px] border border-[#E5E5E0] p-4">
                <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">Wallets</span>
                <span className="break-all font-mono text-xs">{address ?? "—"}</span>
                {hederaId ? (
                  <a
                    href={`https://hashscan.io/testnet/account/${hederaId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-[#2563EB] underline"
                  >
                    Hedera {hederaId} ↗
                  </a>
                ) : (
                  <span className="text-[11px] text-[#6E6E73]">No Hedera account yet, fund this address from <a href="https://faucet.hedera.com" target="_blank" rel="noreferrer" className="text-[#2563EB] underline">faucet.hedera.com</a> to create it.</span>
                )}
              </div>
            {recentCalls.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Recent calls</span>
                {recentCalls.map((r: any) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#F7F7F5] px-3 py-2">
                    <span className="font-mono text-xs">{r.modelId ?? r.model ?? "chat"}</span>
                    <span className="font-mono text-[11px] text-[#6E6E73]">{r.ts ? new Date(Number(r.ts)).toLocaleString("en-US") : ""}</span>
                    {r.settled === false ? (
                      <span className="font-mono text-[11px] text-[#8A5300]">demo</span>
                    ) : (
                      <span className="font-mono text-[11px] text-[#0B7A5D]">settled</span>
                    )}
                    <a
                      href={r.debitTx ? `https://hashscan.io/testnet/transaction/${r.debitTx}` : `https://hashscan.io/testnet/topic/0.0.10379640`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto font-mono text-[11px] text-[#2563EB] underline"
                    >
                      {String(r.id).slice(0, 12)}… ↗
                    </a>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Last onchain payments</span>
              {vaultTxs === null ? (
                <p className="m-0 font-mono text-xs text-[#8F8F8F]">—</p>
              ) : !vaultTxs.length ? (
                <p className="m-0 text-sm text-[#8F8F8F]">no vault transactions yet, subscribe to make the first</p>
              ) : (
                vaultTxs.map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#F7F7F5] px-3 py-2">
                    <span className="rounded-full bg-black px-2.5 py-0.5 text-[11px] text-white">{t.kind}</span>
                    <span className="font-mono text-xs tabular-nums">{t.hbar} HBAR</span>
                    <span className="font-mono text-[11px] text-[#8F8F8F]">{new Date(t.ts).toLocaleString("en-US")}</span>
                    <a
                      href={`https://hashscan.io/testnet/transaction/${t.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto font-mono text-[11px] text-[#2563EB] underline"
                    >
                      {t.id.slice(0, 18)}… ↗
                    </a>
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-3">
              <Link href="/onboarding" className="flex h-10 flex-1 items-center justify-center rounded-full bg-black text-sm text-white">Top up $10</Link>
              <button onClick={refund} disabled={busy || credits === "0"} className="flex h-10 flex-1 items-center justify-center rounded-full border border-black/10 text-sm disabled:opacity-40">
                {busy ? "confirm in wallet…" : "Refund unused"}
              </button>
              <Link href="/api" className="flex h-10 flex-1 items-center justify-center rounded-full border border-black/10 text-sm">API keys</Link>
              <Link href="/team" className="flex h-10 flex-1 items-center justify-center rounded-full border border-black/10 text-sm">Team pools</Link>
            </div>
            {msg && <p className="m-0 font-mono text-xs text-[#6E6E73]">{msg}</p>}
            <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">balances read live from Hedera testnet (relay + vault {VAULT.slice(0, 10)}…)</p>
            <div>
              <button onClick={logout} className="font-mono text-[11px] text-[#8F8F8F] underline hover:text-black">log out of this browser</button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
