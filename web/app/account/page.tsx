"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useExportWallet, useLinkAccount, usePrivy, useUnlinkWallet, useWallets } from "@privy-io/react-auth";
import { createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import { hederaTestnet } from "../../lib/hedera-chains";
import { MockBanner, useMock } from "../components/mock";
import { ApiKeysPanel } from "../api/page";
import OrgMembers from "../team/members";
import TapQueue from "../security/taps";

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

interface Org {
  id: string;
  display_name: string;
  default_key_quorum_id: string;
}

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "wallets", label: "Wallets" },
  { key: "plan", label: "Plan and credits" },
  { key: "keys", label: "API keys" },
  { key: "security", label: "Security" },
  { key: "team", label: "Team" },
  { key: "notifications", label: "Notifications" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function AccountPage() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  const { linkWallet } = useLinkAccount();
  const { unlink } = useUnlinkWallet();
  const { exportWallet } = useExportWallet();
  const [walletMsg, setWalletMsg] = useState<string | null>(null);
  const [mock, toggleMock] = useMock();
  const [tab, setTab] = useState<TabKey>("profile");

  const address = (user?.wallet?.address ?? wallets[0]?.address) as `0x${string}` | undefined;
  const email = (user as any)?.email?.address ?? (user as any)?.google?.email ?? null;
  const me = user ? { did: user.id, wallet: wallets[0]?.address ?? user?.wallet?.address ?? null } : null;

  // profile (display name lives server-side; email/login come from Privy)
  const [displayName, setDisplayName] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  // balances + usage + payments
  const [hbar, setHbar] = useState<string | null>(null);
  const [credits, setCredits] = useState<string | null>(null);
  const [reqCount, setReqCount] = useState<number | null>(null);
  const [paidUsd, setPaidUsd] = useState<number | null>(null);
  const [recentCalls, setRecentCalls] = useState<any[]>([]);
  const [modelSplit, setModelSplit] = useState<{ model: string; calls: number; tokens: number }[]>([]);
  const [vaultTxs, setVaultTxs] = useState<VaultTx[] | null>(null);
  const [hederaId, setHederaId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // team orgs
  const [orgs, setOrgs] = useState<Org[] | null>(null);

  useEffect(() => {
    if (!address) return;
    (async () => {
      try {
        const d: any = await (await fetch(`/api/profile?wallet=${address}`)).json();
        if (d.profile?.displayName) {
          setDisplayName(d.profile.displayName);
          setSavedName(d.profile.displayName);
        }
      } catch {}
    })();
  }, [address]);

  async function saveName() {
    if (!address || !displayName.trim()) return;
    setProfileMsg(null);
    try {
      const r = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: address, displayName: displayName.trim() }),
      });
      const d: any = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setSavedName(d.profile.displayName);
      setProfileMsg("saved ✓");
    } catch (e: any) {
      setProfileMsg(`save failed: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

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
      setMsg(`refunded ✓ ${hash.slice(0, 18)}… — unused credits back as HBAR`);
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
      try {
        const r: any = await (await fetch(`/api/gw/api/users/wallet:${address}/receipts`)).json();
        const mine: any[] = r.data ?? [];
        setReqCount(mine.length);
        setPaidUsd(mine.reduce((a: number, x: any) => a + Number(x.amountCredits ?? 0) * 0.001, 0));
        setRecentCalls(mine.slice(0, 5));
        const byModel = new Map<string, { calls: number; tokens: number }>();
        for (const r of mine) {
          const m = String(r.modelId ?? r.model ?? "unknown");
          const e = byModel.get(m) ?? { calls: 0, tokens: 0 };
          e.calls += 1;
          e.tokens += Number(r.tokensIn ?? 0) + Number(r.tokensOut ?? 0);
          byModel.set(m, e);
        }
        setModelSplit([...byModel.entries()].map(([model, s]) => ({ model, ...s })).sort((a, b) => b.calls - a.calls));
      } catch {
        setReqCount(null);
        setPaidUsd(null);
      }
      try {
        const a: any = await (await fetch(`${MIRROR}/api/v1/accounts/${address}`)).json();
        if (a.account) setHederaId(String(a.account));
      } catch {}
      try {
        const d: any = await (
          await fetch(`${MIRROR}/api/v1/contracts/${VAULT}/results?from=${address}&limit=5&order=desc`)
        ).json();
        setVaultTxs(
          (d.results ?? []).map((t: any) => ({
            id: String(t.hash ?? t.transaction_id),
            ts: Number(String(t.timestamp ?? t.consensus_timestamp ?? "0").split(".")[0]) * 1000,
            hbar: Number(t.amount ?? 0) / 1e8,
            kind: Number(t.amount ?? 0) > 0 ? "subscribe" : "call",
          })),
        );
      } catch {
        setVaultTxs(null);
      }
    })();
  }, [address]);

  useEffect(() => {
    if (tab !== "team" || mock) return;
    (async () => {
      try {
        const r: any = await (await fetch("/api/team/orgs")).json();
        setOrgs(r.data ?? []);
      } catch {
        setOrgs([]);
      }
    })();
  }, [tab, mock]);

  const shownName = savedName ?? displayName ?? email ?? (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Account");
  const initial = shownName.replace(/^did:privy:/, "").charAt(0).toUpperCase() || "?";

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      {mock && <MockBanner onOff={toggleMock} />}
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
          <Link href="/" className="text-[18px] font-semibold">
            Truly<span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm font-medium text-[#6E6E73]">
            <Link href="/chat" className="hover:text-black">Chat</Link>
            <Link href="/network" className="hover:text-black">Network</Link>
            <Link href="/host" className="hover:text-black">Serve</Link>
            <Link href="/docs" className="hover:text-black">Docs</Link>
          </nav>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black text-xs font-medium text-white">{initial}</span>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1200px] items-start gap-10 px-6 py-10">
        <aside className="flex w-56 shrink-0 flex-col gap-1">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black text-sm font-medium text-white">{initial}</span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{shownName}</span>
              <span className="block truncate font-mono text-[11px] text-[#6E6E73]">{email ?? address ?? ""}</span>
            </span>
          </div>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-lg px-3 py-2 text-left text-[15px] ${tab === t.key ? "bg-black/5 font-medium" : "text-[#424242] hover:bg-black/5"}`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={logout}
            className="mt-4 flex h-10 items-center justify-center gap-2 rounded-full border border-black/10 text-sm hover:bg-black/5"
          >
            Sign out
          </button>
        </aside>

        <div className="min-w-0 flex-1">
          {!ready ? (
            <div className="h-32 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
          ) : !authenticated ? (
            <div className="flex flex-col items-center gap-3 rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-12 text-center">
              <p className="m-0 text-sm text-[#6E6E73]">log in to manage your account</p>
              <Link href="/onboarding" className="flex h-10 items-center rounded-full bg-black px-5 text-sm text-white">Log in</Link>
            </div>
          ) : (
            <>
              {tab === "profile" && (
                <div className="flex flex-col gap-6">
                  <div>
                    <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Profile</h1>
                    <p className="m-0 mt-1 text-sm text-[#6E6E73]">How you appear across the app. Receipts stay hash-anonymous either way.</p>
                  </div>
                  <div className="flex flex-col divide-y divide-black/5 rounded-[14px] border border-[#E5E5E0]">
                    <label className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center">
                      <span className="w-40 shrink-0 text-sm text-[#5D5D5D]">Display name</span>
                      <input
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Sanne Koster"
                        className="h-10 flex-1 rounded-lg border border-black/10 px-3 text-sm"
                      />
                    </label>
                    <div className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center">
                      <span className="w-40 shrink-0 text-sm text-[#5D5D5D]">Email</span>
                      <span className="font-mono text-sm">{email ?? "—"}</span>
                    </div>
                    <div className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center">
                      <span className="w-40 shrink-0 text-sm text-[#5D5D5D]">Login method</span>
                      <span className="rounded-full border border-black/10 px-3 py-1 text-xs">Email via Privy</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={saveName} disabled={!displayName.trim()} className="h-10 rounded-full bg-black px-5 text-sm text-white disabled:opacity-40">
                      Save changes
                    </button>
                    {profileMsg && <span className="font-mono text-xs text-[#6E6E73]">{profileMsg}</span>}
                  </div>
                </div>
              )}

              {tab === "wallets" && (
                <div className="flex flex-col gap-6">
                  <div>
                    <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Wallets</h1>
                    <p className="m-0 mt-1 text-sm text-[#6E6E73]">Embedded wallet plus anything you link. Linking never moves funds.</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    {wallets.map((w: any) => (
                      <div key={w.address} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#E5E5E0] px-4 py-2.5">
                        <span className="rounded-full bg-[#F4F4F4] px-2 py-0.5 font-mono text-[10px] text-[#5D5D5D]">
                          {w.walletClientType === "privy" ? "embedded" : "linked"}
                        </span>
                        <span className="break-all font-mono text-xs">{w.address}</span>
                        {wallets.length > 1 && w.address !== address && (
                          <button
                            onClick={async () => {
                              setWalletMsg(null);
                              try {
                                await unlink({ address: w.address });
                              } catch (e: any) {
                                setWalletMsg(`unlink failed: ${String(e?.message ?? e).slice(0, 120)}`);
                              }
                            }}
                            className="ml-auto text-[11px] text-[#6E6E73] underline"
                          >
                            Unlink
                          </button>
                        )}
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => linkWallet()} className="rounded-full border border-black/10 px-4 py-1.5 text-xs hover:bg-black/5">
                        Link a wallet
                      </button>
                      <button
                        onClick={async () => {
                          setWalletMsg(null);
                          try {
                            await exportWallet();
                          } catch (e: any) {
                            setWalletMsg(`export failed: ${String(e?.message ?? e).slice(0, 120)}`);
                          }
                        }}
                        className="rounded-full border border-black/10 px-4 py-1.5 text-xs hover:bg-black/5"
                      >
                        Export private key
                      </button>
                    </div>
                    {walletMsg && <p className="m-0 font-mono text-xs text-[#B3261E]">{walletMsg}</p>}
                    <p className="m-0 text-[11px] text-[#8F8F8F]">Export opens Privy secure iframe, the key never touches this page. Store it offline.</p>
                  </div>
                  <div className="flex flex-col gap-2 rounded-[14px] border border-[#E5E5E0] p-4">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded-full bg-black px-2 py-0.5 font-mono text-[10px] text-white">EVM</span>
                      <span className="break-all font-mono text-xs">{address ?? "—"}</span>
                    </div>
                    {hederaId ? (
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded-full bg-[#E7F5EE] px-2 py-0.5 font-mono text-[10px] text-[#0B7A5D]">HBAR</span>
                        <a href={`https://hashscan.io/testnet/account/${hederaId}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-[#2563EB] underline">
                          {hederaId} ↗
                        </a>
                      </div>
                    ) : (
                      <span className="text-[11px] text-[#6E6E73]">
                        No Hedera account yet. Paste the address above into <a href="https://faucet.hedera.com" target="_blank" rel="noreferrer" className="text-[#2563EB] underline">faucet.hedera.com</a>, the transfer itself creates it.
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1 rounded-[14px] border border-[#E5E5E0] p-4">
                      <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">HBAR · testnet</span>
                      <span className="font-mono text-lg">{hbar ?? "—"}</span>
                    </div>
                    <div className="flex flex-col gap-1 rounded-[14px] border border-[#E5E5E0] p-4">
                      <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">Credits</span>
                      <span className="font-mono text-lg">{credits ?? "—"}</span>
                    </div>
                  </div>
                </div>
              )}

              {tab === "plan" && (
                <div className="flex flex-col gap-6">
                  <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Plan and credits</h1>
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
                  {modelSplit.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Models used</span>
                      {modelSplit.map((m) => (
                        <div key={m.model} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#F7F7F5] px-3 py-2">
                          <span className="font-mono text-xs">{m.model}</span>
                          <span className="font-mono text-[11px] text-[#6E6E73]">{m.calls} call{m.calls === 1 ? "" : "s"}</span>
                          <span className="ml-auto font-mono text-[11px] tabular-nums text-[#6E6E73]">{m.tokens.toLocaleString("en-US")} tokens</span>
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
                          <span className="font-mono text-[11px] text-[#8F8F8F]">{t.ts > 0 && Number.isFinite(t.ts) ? new Date(t.ts).toLocaleString("en-US") : "—"}</span>
                          <a href={`https://hashscan.io/testnet/transaction/${t.id}`} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[11px] text-[#2563EB] underline">
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
                  </div>
                  {msg && <p className="m-0 font-mono text-xs text-[#6E6E73]">{msg}</p>}
                </div>
              )}

              {tab === "keys" && (
                <div className="flex flex-col gap-6">
                  <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">API keys</h1>
                  <ApiKeysPanel />
                </div>
              )}

              {tab === "security" && (
                <div className="flex flex-col gap-6">
                  <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Security</h1>
                  <div className="rounded-[14px] border border-dashed border-black/15 bg-[#F7F7F5] p-4">
                    <p className="m-0 text-sm font-medium">Rotate key ring</p>
                    <p className="m-0 mt-1 font-mono text-xs leading-relaxed text-[#5D5D5D]">
                      wallet-cli ring destroy → ring init (one tap) → re-run gateway/scripts/ring-provision.sh → reboot gateway.
                      Old ciphertext stops decrypting the moment the password changes. No button here on purpose: rotation touches the trustchain root.
                    </p>
                  </div>
                  <TapQueue mock={mock} />
                </div>
              )}

              {tab === "team" && (
                <div className="flex flex-col gap-6">
                  <div>
                    <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Team</h1>
                    <p className="m-0 mt-1 text-sm text-[#6E6E73]">Shared wallets, member allowances, signed approvals. Owners see everything; members see their own caps.</p>
                  </div>
                  {(orgs ?? []).map((o) => (
                    <div key={o.id} className="flex flex-col gap-2 rounded-[14px] border border-[#E5E5E0] p-4">
                      <div className="flex flex-wrap items-center gap-x-3">
                        <span className="text-sm font-medium">{o.display_name}</span>
                        <span className="font-mono text-xs text-[#6E6E73]">{o.id}</span>
                      </div>
                      <OrgMembers orgId={o.id} me={me} mock={mock} />
                    </div>
                  ))}
                  {orgs && !orgs.length && <p className="m-0 text-sm text-[#8F8F8F]">no teams yet — create one on the Teams page</p>}
                  <Link href="/team" className="text-sm text-[#2563EB] underline">Open full Teams page →</Link>
                </div>
              )}

              {tab === "notifications" && (
                <div className="flex flex-col gap-6">
                  <div>
                    <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">Notifications</h1>
                    <p className="m-0 mt-1 text-sm text-[#6E6E73]">Email alerts are not wired yet — nothing below does anything. Watch this space.</p>
                  </div>
                  {[
                    ["Payout settled", "Email with the tx hash"],
                    ["Credits below 10%", "So a run does not stop mid-flight"],
                    ["One of my hosts went degraded", "Heartbeat stale or error rate above 5%"],
                    ["Weekly network digest", "Median prices, new hosts, market share"],
                  ].map(([t, d]) => (
                    <div key={t} className="flex items-center gap-3 rounded-[14px] border border-[#E5E5E0] p-4 opacity-50">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{t}</span>
                        <span className="block text-xs text-[#6E6E73]">{d}</span>
                      </span>
                      <span className="rounded-full bg-[#F4F4F4] px-3 py-1 font-mono text-[11px] text-[#8F8F8F]">soon</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
