"use client";

import Link from "next/link";
import { useState } from "react";

const GATEWAY = "/api/gw"; // same-origin proxy — never localhost (browser prompt + mixed content)
const REGISTRY = "0xa45461bdefef422a81b22f36ebfd0995c7642dc3";

export default function HostSetupPage() {
  const [endpoint, setEndpoint] = useState("http://192.168.1.10:11434");
  const [modelId, setModelId] = useState("llama-3.1-8b");
  const [digest, setDigest] = useState("0x");
  const [priceReq, setPriceReq] = useState("100000");
  const [price1k, setPrice1k] = useState("100000");
  const [stakeHbar, setStakeHbar] = useState("10");
  const [copied, setCopied] = useState(false);
  const [verify, setVerify] = useState<string | null>(null);

  const cmd = `export REGISTRY=${REGISTRY} RPC_URL=https://testnet.hashio.io/api \\
  HOST_KEY=<your-host-key> ENDPOINT=${endpoint} \\
  MODEL_ID=${modelId} MODEL_DIGEST=${digest} \\
  PRICE_PER_REQ_WEI=${priceReq} PRICE_PER_1K_WEI=${price1k} \\
  STAKE_WEI=${BigInt(Math.round(Number(stakeHbar) || 0)) * BigInt(1e18)} sh host-runner/register.sh`;

  async function copy() {
    await navigator.clipboard.writeText(cmd.replace(/\\\n\s*/g, " "));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function check() {
    setVerify("checking…");
    try {
      const h: any = await (await fetch(`${GATEWAY}/api/hosts`)).json();
      const mine = (h.data ?? []).filter((x: any) => x.endpoint === endpoint);
      if (mine.length) {
        const addrs: string[] = JSON.parse(window.localStorage.getItem("tor-my-hosts") ?? "[]");
        for (const m of mine) if (!addrs.includes(m.address)) addrs.push(m.address);
        window.localStorage.setItem("tor-my-hosts", JSON.stringify(addrs));
        setVerify(`registered ✓ ${mine[0].address.slice(0, 10)}… — saved to this browser`);
      } else {
        setVerify("not onchain yet — run the command above, then re-check");
      }
    } catch {
      setVerify("gateway unreachable — is it running?");
    }
  }

  const field = "flex flex-col gap-1.5 text-sm";
  const input = "h-10 rounded-lg border border-black/10 bg-white px-3 font-mono text-[13px]";

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[920px] items-center justify-between px-6">
          <Link href="/host" className="text-sm text-[#6E6E73] hover:text-black">← Serve</Link>
          <span className="text-[15px] font-semibold">Register a host</span>
          <span className="w-16" />
        </div>
      </header>
      <main className="mx-auto flex max-w-[920px] flex-col gap-6 px-6 py-10">
        <div className="flex flex-col gap-2 rounded-[14px] bg-[#0D0D0D] p-5">
          <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#8F8F8F]">Fastest path — one command, key stays on your machine</div>
          <p className="m-0 font-mono text-sm text-[#EDEDED]">sh host-runner/setup.sh</p>
          <p className="m-0 text-[13px] text-[#8F8F8F]">Pulls the model, computes its digest, starts the stack, registers onchain, installs the heartbeat cron. Manual form below if you want each step.</p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className={field}><span className="text-[#6E6E73]">Public endpoint (your Ollama/guard URL)</span><input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className={input} /></label>
          <label className={field}><span className="text-[#6E6E73]">Model ID</span><input value={modelId} onChange={(e) => setModelId(e.target.value)} className={input} /></label>
          <label className={field}><span className="text-[#6E6E73]">Model digest (0x sha256 of modelfile)</span><input value={digest} onChange={(e) => setDigest(e.target.value)} className={input} placeholder="0x…" /></label>
          <label className={field}><span className="text-[#6E6E73]">Stake (HBAR, min 10 testnet)</span><input value={stakeHbar} onChange={(e) => setStakeHbar(e.target.value)} className={input} inputMode="decimal" /></label>
          <label className={field}><span className="text-[#6E6E73]">Price / req (delivered units; 100000 ≈ 1 credit)</span><input value={priceReq} onChange={(e) => setPriceReq(e.target.value)} className={input} inputMode="numeric" /></label>
          <label className={field}><span className="text-[#6E6E73]">Price / 1k tokens (delivered units)</span><input value={price1k} onChange={(e) => setPrice1k(e.target.value)} className={input} inputMode="numeric" /></label>
        </div>
        <div className="flex flex-col gap-2 rounded-[14px] border border-[#E5E5E0] bg-[#0D0D0D] p-5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-[#8B95A5]">run this where your host key lives — key never leaves your machine</span>
            <button onClick={copy} className="rounded-full bg-white px-3 py-1 text-xs text-black">{copied ? "copied ✓" : "copy"}</button>
          </div>
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-[#E6EAF0]">{cmd}</pre>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={check} className="flex h-10 items-center rounded-full bg-black px-5 text-sm text-white hover:bg-zinc-800">Verify onchain</button>
          {verify && <span className="font-mono text-xs text-[#6E6E73]">{verify}</span>}
          <Link href="/host/dashboard" className="ml-auto text-sm text-[#2563EB] underline">My hosts →</Link>
        </div>
      </main>
    </div>
  );
}
