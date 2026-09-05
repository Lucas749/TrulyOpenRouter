"use client";

import { useEffect, useState } from "react";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:4021";

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

  async function send() {
    const text = input.trim();
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
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col p-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">TrulyOpenRouter</h1>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="rounded-full border border-black/10 px-3 py-1 text-sm"
        >
          <option value={model}>{model}</option>
          {models.filter((m) => m.id !== model).map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </select>
      </header>
      <div className="flex flex-1 flex-col gap-3">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "self-end rounded-2xl bg-black px-4 py-2 text-white" : "self-start rounded-2xl bg-black/5 px-4 py-2"}>
            <p className="whitespace-pre-wrap text-sm">{m.content}</p>
            {m.receipt && (
              <p className="mt-1 font-mono text-[11px] text-emerald-700">
                ✓ {m.receipt.slice(0, 12)}… · settled={String(m.settled)}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask anything…"
          className="h-11 flex-1 rounded-full border border-black/10 px-4 text-sm outline-none focus:border-black/30"
        />
        <button onClick={send} disabled={busy} className="h-11 rounded-full bg-black px-5 text-sm text-white disabled:opacity-50">
          {busy ? "…" : "Send"}
        </button>
      </div>
    </main>
  );
}
