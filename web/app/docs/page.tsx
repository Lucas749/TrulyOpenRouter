"use client";

import Link from "next/link";
import { useState } from "react";

function Snippet({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-[#E5E5E0] p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <button onClick={copy} className="rounded-full bg-[#F4F4F4] px-3 py-1 font-mono text-xs hover:bg-[#ECECEC]">{copied ? "copied ✓" : "copy"}</button>
      </div>
      <pre className="m-0 overflow-x-auto rounded-lg bg-[#0D0D0D] p-4 font-mono text-xs leading-relaxed text-[#E6EAF0]">{code}</pre>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[920px] items-center justify-between px-6">
          <Link href="/" className="text-[18px] font-semibold">Truly<span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span></Link>
          <nav className="flex items-center gap-6 text-sm font-medium text-[#6E6E73]">
            <Link href="/chat" className="hover:text-black">Chat</Link>
            <Link href="/network" className="hover:text-black">Network</Link>
            <Link href="/host" className="hover:text-black">Serve</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex max-w-[920px] flex-col gap-6 px-6 py-10">
        <div>
          <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">API docs</h1>
          <p className="mb-0 mt-2 text-[#5D5D5D]">OpenAI-compatible. Two env vars and any harness works — opencode, Cursor, Cline, or plain curl. Testnet gateway: <span className="font-mono text-sm text-black">http://127.0.0.1:4121</span> (local) · contracts on Hedera testnet.</p>
          <nav className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {["quickstart", "chat", "models", "receipts", "keys", "hosts", "errors"].map((a) => (
              <a key={a} href={`#${a}`} className="font-mono text-xs text-[#2563EB] underline">{a}</a>
            ))}
          </nav>
        </div>
        <div id="quickstart"></div>
        <Snippet title="Run everything locally (CLI, stack, Ledger, Privy)" code={`git clone https://github.com/Lucas749/TrulyOpenRouter && cd TrulyOpenRouter
sh quickstart.sh   # ~15 min, testnet only, nothing costs money`} />
        <Snippet title="Serve a model (one command, key stays on your machine)" code={`sh host-runner/setup.sh   # pull → stack → digest → register → heartbeat cron
# full manual walkthrough: SELF-HOST.md in the repo`} />
        <div id="chat"></div>
        <Snippet title="Python (openai SDK)" code={`from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:4121/v1",
    api_key="tor_sk_…",  # create at /api
)

response = client.chat.completions.create(
    model="qwen2.5:0.5b",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)`} />
        <Snippet title="opencode provider" code={`# opencode.json, custom provider pointing at the router
{
  "$schema": "https://opencode.ai/config.json",
  "model": "trulyopenrouter/qwen2.5-7b",
  "provider": {
    "trulyopenrouter": {
      "options": { "baseURL": "http://127.0.0.1:4121/v1", "apiKey": "tor_sk_…" }
    }
  }
}`} />
        <Snippet title="Keys + receipts (curl)" code={`# issue a scoped key (shown once)
curl -X POST http://127.0.0.1:4121/api/keys \\
  -H 'Content-Type: application/json' \\
  -d '{"scopes":{"models":["qwen2.5:0.5b"]}}'

# chat, response carries tor_receipt + tor_settled
curl -X POST http://127.0.0.1:4121/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -H "Authorization: Bearer tor_sk_…" \\
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"hi"}]}'

# verify the receipt (hashes only, bodies never leave the hosts)
curl http://127.0.0.1:4121/api/receipts/<id>

# network truth
curl http://127.0.0.1:4121/api/hosts
curl http://127.0.0.1:4121/api/stats`} />
        <div id="models"></div>
        <Snippet title="Models (live directory)" code={`curl http://127.0.0.1:4121/v1/models
# -> [{ id, hosts, minPricePerReq, calls24h }] — cheapest healthy host wins per call`} />
        <div id="receipts"></div>
        <Snippet title="Receipts (hashes only, bodies never leave hosts)" code={`curl http://127.0.0.1:4121/api/receipts/<id>
# -> { id (sha256), modelDigest, host, priceWei, debitTx, hcsSeq }
# debitTx: vault debit on HashScan · hcsSeq: same id on topic 0.0.10379640`} />
        <div id="keys"></div>
        <Snippet title="Keys, caps and quota" code={`# scoped key (models allowlist, expiry) — shown once
curl -X POST http://127.0.0.1:4121/api/keys -d '{"scopes":{"models":["qwen2.5:0.5b"]}}'
# member allowance: 429 quota_exceeded past cap · vault debit is the backstop
# key budget accounts derive per prefix (HKDF) — fund explicitly, never auto`} />
        <div id="hosts"></div>
        <Snippet title="Host API (serve + earn)" code={`# register (4 HBAR stake + 1 HBAR gas reserve; key stays on your machine)
sh host-runner/setup.sh
# directory + detail + verify
curl http://127.0.0.1:4121/api/hosts
curl http://127.0.0.1:4121/api/hosts/<address>
# heartbeat (cron every 10 min keeps you in rotation) · leave: tor-host leave`} />
        <div id="errors"></div>
        <Snippet title="Errors (honest codes, no fake 200s)" code={`401 invalid_api_key  — unknown/revoked key or bad wallet signature
402 payment_required — wallet out of credits, subscribe first
404 model_not_found  — model not in key scope, or unknown receipt/host
409 conflict         — e.g. member already active, tap already decided
429 quota_exceeded   — member allowance spent, owner raises it in /team
501 unavailable      — leg not configured (admin token, vault, tap signer)
502 upstream_error   — host/gateway leg failed, receipt still recorded where possible`} />
        <div className="rounded-[14px] border border-[#E5E5E0] bg-[#F7F7F5] p-5 text-sm leading-relaxed text-[#5D5D5D]">
          <p className="m-0 mb-2 font-medium text-black">Money path (Hedera testnet)</p>
          <p className="m-0 font-mono text-xs leading-relaxed">Registry 0xa454…dc3 · Vault 0xd75c…f576 · USDC 0.0.429274 · facilitator api.testnet.blocky402.com · 1 credit ≡ $0.001 by definition · contract value unit is tinybar (sent/1e10), see SPEC money rule.</p>
          <p className="mb-0 mt-2"><Link href="/api" className="text-[#2563EB] underline">Manage keys →</Link></p>
        </div>
      </main>
    </div>
  );
}
