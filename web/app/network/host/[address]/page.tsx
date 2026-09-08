"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, parseAbi } from "viem";
import { hederaTestnet } from "../../../../lib/hedera-chains";
import { MockBanner, useMock } from "../../../components/mock";
import { MOCK_HOSTS } from "../../../../lib/mock";
import { accountUrl, topicUrl, txUrl } from "../../../../lib/chain";

const GATEWAY = "/api/gw"; // same-origin proxy, never localhost (browser prompt + mixed content)
const REGISTRY = "0xa45461bdefef422a81b22f36ebfd0995c7642dc3";
const REGISTRY_ABI = parseAbi(["function challenge(address host, bytes32 receiptId)"]);

export default function HostDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const [mock, toggleMock] = useMock();
  const [d, setD] = useState<any | null>(null);
  const [missing, setMissing] = useState(false);
  const [flagMsg, setFlagMsg] = useState<string | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();

  async function load() {
    try {
      const r = await fetch(`${GATEWAY}/api/hosts/${address}`);
      if (r.status === 404) setMissing(true);
      else setD(await r.json());
    } catch {}
  }

  useEffect(() => {
    if (mock) {
      const m = MOCK_HOSTS.find((h) => h.address.toLowerCase() === address.toLowerCase());
      if (m) setD({ ...m, lastHeartbeat: 0, challenged: false, earningsWei: null, receipts: [] });
      else setMissing(true);
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mock, address]);

  // On-demand model-identity spot check. Probes are paid calls like any other traffic.
  async function verifyNow() {
    if (!d) return;
    setVerifyBusy(true);
    setVerifyMsg(null);
    try {
      const r = await fetch(`${GATEWAY}/api/verify/${address}`, { method: "POST" });
      const report: any = await r.json();
      if (!r.ok) throw new Error(report.error?.message ?? r.status);
      setVerifyMsg(
        report.inconclusive
          ? "inconclusive, host unreachable, not counted against it"
          : `${report.passed}/${report.total} probes match${report.verification?.failing ? ", FAILING, out of rotation" : ""}`,
      );
      await load();
    } catch (e: any) {
      setVerifyMsg(`verify failed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    setVerifyBusy(false);
  }
  // Anyone with a wallet can challenge, review (not auto-slash) is the v1 semantic.
  // Flag a host with its latest failed receipt (or zero hash for general review).
  // Anyone with a wallet can challenge, review (not auto-slash) is the v1 semantic.
  async function flag() {
    const w = wallets[0];
    const from = w?.address as `0x${string}` | undefined;
    if (!w || !from || !d) return;
    setFlagBusy(true);
    setFlagMsg(null);
    try {
      await w.switchChain(hederaTestnet.id);
      const provider = await w.getEthereumProvider();
      const client = createWalletClient({ account: from, chain: hederaTestnet, transport: custom(provider) });
      const receiptId = ((d.receipts ?? [])[0]?.id ?? "") as string;
      const id32 = receiptId.length >= 64 ? `0x${receiptId.slice(0, 64)}` : `0x${"00".repeat(32)}`;
      const hash = await client.writeContract({
        address: REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "challenge",
        args: [address as `0x${string}`, id32 as `0x${string}`],
      });
      setFlagMsg(`challenged ✓ ${hash.slice(0, 18)}…, queued for review (no auto-slash in v1)`);
      await load();
    } catch (e: any) {
      setFlagMsg(`challenge failed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    setFlagBusy(false);
  }

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      {mock && <MockBanner onOff={toggleMock} />}
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[920px] items-center justify-between px-6">
          <Link href="/network" className="text-sm text-[#6E6E73] hover:text-black">← Network</Link>
          <a href={accountUrl(address)} target="_blank" rel="noreferrer" className="font-mono text-sm text-[#2563EB]">{address.slice(0, 10)}… ↗</a>
          <button onClick={toggleMock} className="font-mono text-xs text-[#6E6E73] underline">{mock ? "real" : "mock"}</button>
        </div>
      </header>
      <main className="mx-auto flex max-w-[920px] flex-col gap-6 px-6 py-8">
        {!d && !missing && <div className="h-40 animate-pulse rounded-[14px] bg-[#F4F4F4]" />}
        {missing && <p className="rounded-[14px] border border-dashed border-[#E5E5E0] px-6 py-12 text-center text-sm text-[#8F8F8F]">unknown host, check the address or <Link href="/network" className="text-[#2563EB] underline">browse the directory</Link></p>}
        {d && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm"><span className={`h-2 w-2 rounded-full ${d.active ? "bg-[#10A37F]" : "bg-[#DC2626]"}`} />{d.active ? "serving" : "offline"}</span>
              <span className="rounded-full bg-[#F4F4F4] px-2.5 py-0.5 text-xs">{d.modelId}</span>
              {d.challenged ? <span className="rounded-full bg-[#FDECEA] px-2.5 py-0.5 text-xs text-[#B3261E]">challenged, under review</span> : null}
              {!mock && !d.challenged && (
                <button onClick={flag} disabled={flagBusy || !authenticated} title={authenticated ? "Flag with latest receipt (wallet signs)" : "Log in to flag"} className="rounded-full border border-black/10 px-2.5 py-0.5 text-xs disabled:opacity-40">
                  {flagBusy ? "flagging…" : "Flag host"}
                </button>
              )}
            </div>
            {flagMsg && <p className="m-0 font-mono text-xs text-[#6E6E73]">{flagMsg}</p>}
            <div className="flex flex-col gap-2 rounded-[14px] border border-[#E5E5E0] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">Model check</span>
                {d.verification && d.verification.checks > 0 && d.verification.avgScore !== null ? (
                  <span className={`font-mono text-sm ${d.verification.failing ? "text-[#B3261E]" : "text-[#0B7A5D]"}`}>
                    {d.verification.failing ? "failing" : "✓"} {(d.verification.avgScore * 100).toFixed(0)}% · {d.verification.checks} check{d.verification.checks === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span className="font-mono text-sm text-[#8F8F8F]">unchecked, anyone can run the probes</span>
                )}
                {!mock && (
                  <button onClick={verifyNow} disabled={verifyBusy} className="ml-auto rounded-full border border-black/10 px-2.5 py-0.5 text-xs disabled:opacity-40">
                    {verifyBusy ? "probing…" : "Verify now"}
                  </button>
                )}
              </div>
              <p className="m-0 text-xs leading-relaxed text-[#6E6E73]">
                Deterministic fingerprint probes (temperature 0, fixed seed) vs. reference outputs
                captured from the pinned serving stack. Probes are paid calls, the host earns for them.
              </p>
              {verifyMsg && <p className="m-0 font-mono text-xs text-[#6E6E73]">{verifyMsg}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {[
                ["PRICE / REQ", d.pricePerReq],
                ["PRICE / 1K", d.pricePer1kTokens],
                ["STAKE", d.stake],
                ["24H CALLS", String(d.calls24h ?? "—")],
                ["RELIABILITY", d.reliability === null || d.reliability === undefined ? "—" : `${(d.reliability * 100).toFixed(1)}%`],
                ["EARNINGS", d.earningsWei ?? "—"],
                ["REGION", d.region ?? "unreported"],
                ["MODEL DIGEST", String(d.modelDigest ?? "—").slice(0, 12) + "…"],
              ].map(([l, v]) => (
                <div key={l} className="flex flex-col gap-1 rounded-[14px] border border-[#E5E5E0] p-4">
                  <span className="text-[10px] uppercase tracking-[0.1em] text-[#5D5D5D]">{l}</span>
                  <span className="break-all font-mono text-sm">{v}</span>
                </div>
              ))}
            </div>
            <div>
              <h2 className="mb-3 text-[18px] font-medium">Recent receipts</h2>
              {(d.receipts ?? []).length ? (
                <div className="flex flex-col gap-2">
                  {(d.receipts ?? []).map((r: any) => (
                    <div key={r.id} className="flex flex-wrap items-center gap-x-3 rounded-xl border border-[#E5E5E0] px-4 py-2.5 font-mono text-xs">
                      <span className="text-[#0B7A5D]">✓ {r.id.slice(0, 12)}…</span>
                      <span className="text-[#6E6E73]">{r.priceWei} wei · {(r.tokensIn ?? 0) + (r.tokensOut ?? 0)} tok · {r.latencyMs}ms</span>
                      <a href={r.debitTx ? txUrl(r.debitTx) : topicUrl()} target="_blank" rel="noreferrer" className="ml-auto text-[#2563EB]">proof ↗</a>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[#8F8F8F]">no receipts recorded for this host yet</p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
