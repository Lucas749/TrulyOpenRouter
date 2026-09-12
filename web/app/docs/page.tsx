"use client";

import Link from "next/link";
import { useState } from "react";
import { Wordmark } from "../components/mark";

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

function Node({ title, meta, sub, dark }: { title: string; meta?: string; sub?: string; dark?: boolean }) {
  return (
    <div className={`rounded-[12px] border p-4 ${dark ? "border-[#0D0D0D] bg-[#0D0D0D]" : "border-[#E5E5E0] bg-white"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={`text-sm font-medium ${dark ? "text-white" : "text-black"}`}>{title}</span>
        {meta ? <span className={`font-mono text-[11px] ${dark ? "text-[#8FA0B8]" : "text-[#6E6E73]"}`}>{meta}</span> : null}
      </div>
      {sub ? <p className={`m-0 mt-1.5 font-mono text-[11px] leading-relaxed ${dark ? "text-[#A9B2C0]" : "text-[#6E6E73]"}`}>{sub}</p> : null}
    </div>
  );
}

function Step({ label }: { label: string }) {
  return (
    <div className="flex items-start gap-3 py-1 pl-4">
      <span className="mt-px text-base leading-none text-[#C9C9C4]">↓</span>
      <span className="font-mono text-[11px] leading-relaxed text-[#5D5D5D]">{label}</span>
    </div>
  );
}

function Contract({ name, address, lines }: { name: string; address: string; lines: string[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-[#E5E5E0] p-5">
      <span className="text-sm font-medium">{name}</span>
      <a
        href={`https://hashscan.io/testnet/contract/${address}`}
        target="_blank"
        rel="noreferrer"
        className="break-all font-mono text-[11px] text-[#2563EB] underline"
      >
        {address}
      </a>
      <ul className="m-0 mt-1 flex list-none flex-col gap-1.5 p-0">
        {lines.map((l) => (
          <li key={l} className="font-mono text-[11px] leading-relaxed text-[#5D5D5D]">{l}</li>
        ))}
      </ul>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[920px] items-center justify-between px-6">
          <Link href="/" >
            <Wordmark /></Link>
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
          <p className="mb-0 mt-2 text-[#5D5D5D]">OpenAI-compatible. Two env vars and any harness works — opencode, Cursor, Cline, or plain curl. Base URL: <span className="font-mono text-sm text-black">https://trulyopenrouter.vercel.app/api/gw/v1</span> · contracts on Hedera testnet. Running the stack yourself? Swap the base for <span className="font-mono text-sm text-black">http://localhost:4121/v1</span>.</p>
          <nav className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {["architecture", "quickstart", "chat", "models", "receipts", "keys", "hosts", "errors"].map((a) => (
              <a key={a} href={`#${a}`} className="font-mono text-xs text-[#2563EB] underline">{a}</a>
            ))}
          </nav>
        </div>
        <section id="architecture" className="flex flex-col gap-5">
          <div>
            <h2 className="m-0 text-[20px] font-normal tracking-[-0.01em]">How it fits together</h2>
            <p className="mb-0 mt-2 text-sm leading-relaxed text-[#5D5D5D]">
              Two contracts on Hedera testnet and one off-chain router. You put HBAR into the vault and get
              credits. Anyone can run a host — stake, register, serve. Every routed call moves money twice:
              once to the host in USDC over x402, once against your credits in the vault.
            </p>
          </div>

          <div className="flex flex-col gap-1 rounded-[14px] border border-[#E5E5E0] bg-[#FCFCFB] p-5">
            <Node
              title="You"
              meta="any wallet"
              sub="subscribe(planId) payable — plan 0 is 10 HBAR → 10,000 credits"
            />
            <Step label="prompt → POST /v1/chat/completions" />
            <Node
              title="Gateway"
              meta="off-chain router"
              sub="checks your limits before any money moves · picks a host on price, latency, stake and reliability"
              dark
            />
            <Step label="host's guard answers HTTP 402 payment_required" />
            <Step label="gateway pays $0.001 test USDC over x402 — settled by the Blocky402 facilitator" />
            <Node
              title="Host"
              meta="anyone · 4 HBAR stake"
              sub="register() on HostRegistry, then serves the completion from its own GPU"
            />
            <Step label="gateway calls debit(user, host, credits, receiptHash)" />
            <Node
              title="SubscriptionVault"
              meta="holds the HBAR"
              sub="credits[you] −N · hostEarnings[host] +90% · accruedFees +10%"
            />
            <Step label="host calls withdraw() and pulls its earnings as HBAR" />
            <Node title="Receipt" meta="id = sha256" sub="both legs recorded, id mirrored to HCS topic 0.0.10379640" />
          </div>

          <div className="rounded-[14px] border border-[#E5E5E0] bg-[#F7F7F5] p-5 text-sm leading-relaxed text-[#5D5D5D]">
            <p className="m-0 mb-2 font-medium text-black">Two money legs, deliberately separate</p>
            <p className="m-0">
              The host is paid <span className="font-medium text-black">per request in test USDC</span> by the
              gateway over x402. Your <span className="font-medium text-black">credits</span> are metered down
              in the vault, where the host&apos;s 90% share accrues in HBAR and is withdrawn separately. HBAR you
              deposit never converts into USDC — the gateway funds the USDC leg from its own account. A receipt
              ties both legs to one call.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Contract
              name="SubscriptionVault"
              address="0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576"
              lines={[
                "subscribe(planId) payable — buy credits",
                "debit(user, host, amount, receiptHash) — gateway only",
                "withdraw() — host pulls earnings as HBAR",
                "refund() — cash out unused credits at a fixed rate",
                "daily quota + per-user spend caps enforced in-contract",
                "PROTOCOL_FEE_BPS = 1000 → 10% fee, 90% to the host",
              ]}
            />
            <Contract
              name="HostRegistry"
              address="0x5f83c19413fc15181e2e79512947e374c7b8dc56"
              lines={[
                "register(...) — 4 HBAR min stake, model id + digest",
                "heartbeat() — stay in rotation",
                "updatePricing(pricePerReq, pricePer1kTokens)",
                "deregister() → release() after a 24h timelock",
                "challenge(host, receiptId) — dispute hook",
                "eligibleHosts(modelId) — what the router reads",
              ]}
            />
          </div>

          <Snippet
            title="Verify the facilitator yourself (live)"
            code={`curl -s https://trulyopenrouter.vercel.app/api/gw/api/config | jq
# -> { chainId: 296, registry, vault,
#      facilitator: "https://api.testnet.blocky402.com",
#      usdc: "0.0.429274" }`}
          />
        </section>
        <div id="quickstart"></div>
        <Snippet title="Run everything locally (CLI, stack, Ledger, Privy)" code={`git clone https://github.com/Lucas749/TrulyOpenRouter && cd TrulyOpenRouter
sh quickstart.sh   # ~15 min, testnet only, nothing costs money`} />
        <Snippet title="Serve a model (one command, key stays on your machine)" code={`sh host-runner/setup.sh   # pull → stack → digest → register → heartbeat cron
# full manual walkthrough: host-runner/README.md in the repo`} />
        <div id="chat"></div>
        <Snippet title="Python (openai SDK)" code={`from openai import OpenAI

client = OpenAI(
    base_url="https://trulyopenrouter.vercel.app/api/gw/v1",
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
      "options": { "baseURL": "https://trulyopenrouter.vercel.app/api/gw/v1", "apiKey": "tor_sk_…" }
    }
  }
}`} />
        <Snippet title="Keys + receipts (curl)" code={`# issue a scoped key for your login (shown once; easiest at /api)
curl -X POST https://trulyopenrouter.vercel.app/api/gw/api/keys \\
  -H 'Content-Type: application/json' \\
  -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" \\
  -d '{"scopes":{"models":["qwen2.5:0.5b"]}}'

# chat, response carries tor_receipt + tor_settled
curl -X POST https://trulyopenrouter.vercel.app/api/gw/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -H "Authorization: Bearer tor_sk_…" \\
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"hi"}]}'

# verify the receipt (hashes only, bodies never leave the hosts)
curl https://trulyopenrouter.vercel.app/api/gw/api/receipts/<id>

# network truth
curl https://trulyopenrouter.vercel.app/api/gw/api/hosts
curl https://trulyopenrouter.vercel.app/api/gw/api/stats`} />
        <div id="models"></div>
        <Snippet title="Models (live directory)" code={`curl https://trulyopenrouter.vercel.app/api/gw/v1/models
# -> [{ id, hosts, minPricePerReq, calls24h }] — cheapest healthy host wins per call`} />
        <div id="receipts"></div>
        <Snippet title="Receipts (hashes only, bodies never leave hosts)" code={`curl https://trulyopenrouter.vercel.app/api/gw/api/receipts/<id>
# -> { id (sha256), modelDigest, host, priceWei, debitTx, hcsSeq }
# debitTx: vault debit on HashScan · hcsSeq: same id on topic 0.0.10379640`} />
        <div id="keys"></div>
        <Snippet title="Keys, caps and quota" code={`# scoped key for your login (models allowlist, expiry) — shown once
curl -X POST https://trulyopenrouter.vercel.app/api/gw/api/keys -H 'Content-Type: application/json' -H "Authorization: Bearer $PRIVY_ACCESS_TOKEN" -d '{"scopes":{"models":["qwen2.5:0.5b"]}}'
# member allowance: 429 quota_exceeded past cap · vault debit is the backstop
# key budget accounts derive per prefix (HKDF) — fund explicitly, never auto`} />
        <div id="hosts"></div>
        <Snippet title="Host API (serve + earn)" code={`# register (4 HBAR stake + 1 HBAR gas reserve; key stays on your machine)
sh host-runner/setup.sh
# directory + detail + verify
curl https://trulyopenrouter.vercel.app/api/gw/api/hosts
curl https://trulyopenrouter.vercel.app/api/gw/api/hosts/<address>
# heartbeat (cron every 10 min keeps you in rotation) · leave: tor-host leave`} />
        <div id="errors"></div>
        <Snippet title="Errors" code={`401 invalid_api_key  — unknown/revoked key or bad wallet signature
402 payment_required — wallet out of credits, subscribe first
404 model_not_found  — model not in key scope, or unknown receipt/host
409 conflict         — e.g. member already active, tap already decided
429 quota_exceeded   — member allowance spent, owner raises it in /team
501 unavailable      — leg not configured (admin token, vault, tap signer)
502 upstream_error   — host/gateway leg failed, receipt still recorded where possible`} />
        <p className="m-0 text-sm"><Link href="/api" className="text-[#2563EB] underline">Manage keys →</Link></p>
      </main>
    </div>
  );
}
