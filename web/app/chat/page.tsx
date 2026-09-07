"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import LoginButton from "../components/login-button";

const SUGGESTIONS = ["Summarise this contract clause in two sentences.", "What can you run on a laptop GPU?", "How do host payouts work?"];

const GATEWAY = "/api/gw"; // same-origin proxy — never localhost (browser prompt + mixed content)

interface Msg {
  role: string;
  content: string;
  receipt?: string;
  settled?: boolean;
}

export default function ChatPage() {
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [model, setModel] = useState("qwen2.5:0.5b");
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, busy]);

  useEffect(() => {
    fetch(`${GATEWAY}/v1/models`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.length) {
          setModels(d.data);
          setModel(d.data[0].id);
        }
      })
      .catch(() => {});
  }, []);

  async function send(prefill?: string) {
    const text = (prefill ?? input).trim();
    if (!text || busy) return;
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setInput("");
    try {
      const r = await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
      });
      const d = await r.json();
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content: r.ok ? String(d.choices?.[0]?.message?.content ?? "…") : `Error: ${d.error?.message}`,
          receipt: d.tor_receipt,
          settled: d.tor_settled,
        },
      ]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: `Gateway unreachable (${GATEWAY}). Is it running?` }]);
    }
    setBusy(false);
  }

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-2xl items-center justify-between px-6">
          <Link href="/" className="text-[18px] font-semibold">Truly<span className="text-[15px] font-normal text-[#8F8F8F]">OpenRouter</span></Link>
          <nav className="flex items-center gap-5 text-sm font-medium text-[#6E6E73]">
            <span className="text-black">Chat</span>
            <Link href="/network" className="hover:text-black">Network</Link>
            <Link href="/host" className="hover:text-black">Serve</Link>
          </nav>
          <LoginButton />
        </div>
      </header>
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-2xl flex-col px-6">
      <div className="flex items-center justify-end py-3">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="rounded-full border border-black/10 px-3 py-1 text-sm"
          aria-label="Model"
        >
          <option value={model}>{model}</option>
          {models.filter((m) => m.id !== model).map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </select>
      </div>
      {msgs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 pb-16 text-center">
          <h1 className="m-0 text-[28px] font-normal tracking-[-0.02em]">What can I help with?</h1>
          <div className="flex max-w-xl flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                disabled={busy}
                className="rounded-full border border-black/10 px-4 py-2 text-[13px] text-[#424242] hover:bg-black/5 disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
          <p className="m-0 max-w-md text-xs leading-relaxed text-[#8F8F8F]">
            Every answer settles onchain — receipt hash below each reply. Prompts and completions stay off-chain.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col divide-y divide-black/5 rounded-[14px] border border-[#E5E5E0] bg-white px-5">
          {msgs.map((m, i) => (
            <div key={i} className={`flex flex-col gap-1 py-4 ${m.role === "user" ? "items-end" : "items-start"}`}>
              <div className={m.role === "user" ? "max-w-[85%] rounded-2xl bg-black px-4 py-2 text-white" : "w-full"}>
                <p className="m-0 whitespace-pre-wrap text-[15px] leading-relaxed">{m.content}</p>
              </div>
              {m.receipt && (
                <p className="m-0 font-mono text-[11px] text-emerald-700">
                  ✓ {m.receipt.slice(0, 12)}… · settled={String(m.settled)}
                </p>
              )}
            </div>
          ))}
          {busy && <div className="flex items-center gap-1 py-4 text-[#8F8F8F]"><span className="animate-pulse text-sm">thinking…</span></div>}
          <div ref={bottomRef} />
        </div>
      )}
      <div className="sticky bottom-0 border-t border-[#E5E5E0] bg-white/95 py-4 backdrop-blur">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Ask anything…"
            className="h-11 flex-1 rounded-full border border-black/10 px-4 text-sm outline-none focus:border-black/30"
          />
          <button onClick={() => send()} disabled={busy} className="h-11 rounded-full bg-black px-5 text-sm text-white disabled:opacity-50">
            {busy ? "…" : "Send"}
          </button>
        </div>
      </div>
    </main>
    </div>
  );
}
