"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import LoginButton from "../components/login-button";
import { useAuthFetch } from "../components/use-auth-fetch";
import { Wordmark } from "../components/mark";

const SUGGESTIONS = ["Summarise this contract clause in two sentences.", "What can you run on a laptop GPU?", "How do host payouts work?"];

const GATEWAY = "/api/gw"; // same-origin proxy, never localhost (browser prompt + mixed content)

interface Msg {
  role: string;
  content: string;
  receipt?: string;
  settled?: boolean;
  subscribeCta?: boolean;
}

interface Thread {
  id: string;
  title: string;
  updatedAt: number;
  msgs: Msg[];
}

const THREADS_KEY = "tor-threads";

function loadThreads(): Thread[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(THREADS_KEY) ?? "[]") as Thread[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function emptyThread(): Thread {
  const now = Date.now();
  return { id: `t_${now.toString(36)}`, title: "New chat", updatedAt: now, msgs: [] };
}

export default function ChatPage() {
  const { wallets } = useWallets();
  const { getAccessToken, login, authenticated } = usePrivy();
  // Logged-in identity = first wallet. Server threads follow the login
  // (any browser); logged-out keeps localStorage threads (this browser only).
  const handle = wallets[0]?.address ?? null;
  const handleRef = useRef<string | null>(null);
  useEffect(() => { handleRef.current = handle; }, [handle]);
  const [viewTime] = useState(() => Date.now());
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [model, setModel] = useState("qwen2.5:0.5b");
  const [input, setInput] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const authFetch = useAuthFetch();
  // Bill to personal credits or a team you belong to (team wallet credits).
  const [teams, setTeams] = useState<{ id: string; display_name: string }[]>([]);
  const [billTo, setBillTo] = useState("personal");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!authenticated) return;
    authFetch("/api/team/orgs")
      .then((r) => r.json())
      .then((d) => setTeams(Array.isArray(d.data) ? d.data : []))
      .catch(() => setTeams([]));
  }, [authenticated, authFetch]);

  const msgs = useMemo(() => threads.find((t) => t.id === currentId)?.msgs ?? [], [threads, currentId]);

  function persist(next: Thread[]) {
    setThreads(next);
    const h = handleRef.current;
    if (h) {
      // Server history (cross-browser). Fire-and-forget: chat never blocks on it.
      fetch("/api/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: h, threads: next.slice(0, 30) }),
      }).catch(() => {});
    } else {
      try {
        window.localStorage.setItem(THREADS_KEY, JSON.stringify(next.slice(0, 30)));
      } catch {}
    }
  }

  function newChat() {
    const t = emptyThread();
    persist([t, ...threads]);
    setCurrentId(t.id);
    setInput("");
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, busy]);

  useEffect(() => {
    (async () => {
      const existing = handle
        ? ((await (await fetch(`/api/chat/threads?user=${encodeURIComponent(handle)}`)).json().catch(() => ({}))) as { threads?: Thread[] }).threads ?? []
        : loadThreads();
      setThreads(existing);
      setCurrentId(existing.length ? existing[0].id : null);
    })().catch(() => {});
  }, [handle]);

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
    if (!authenticated) { login(); return; }
    let id = currentId;
    let snapshot = threads;
    if (!id) {
      const t = emptyThread();
      snapshot = [t, ...threads];
      id = t.id;
      setCurrentId(id);
    }
    const activeId = id;
    const apply = (msg: Msg, title?: string) => {
      snapshot = snapshot.map((t) =>
        t.id === activeId ? { ...t, msgs: [...t.msgs, msg], updatedAt: Date.now(), title: title ?? t.title } : t,
      );
      persist(snapshot);
    };
    setBusy(true);
    const isFirst = (snapshot.find((t) => t.id === activeId)?.msgs.length ?? 0) === 0;
    apply({ role: "user", content: text }, isFirst ? text.slice(0, 42) : undefined);
    setInput("");
    try {
      const token = await getAccessToken();
      if (!token) {
        apply({ role: "assistant", content: "Sign in again to continue." });
        setBusy(false);
        login();
        return;
      }
      const r = await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        // The gateway verifies that the selected wallet belongs to this login, or
        // that this login is an active member of the selected team.
        body: JSON.stringify({ model, messages: [{ role: "user", content: text }], ...(billTo !== "personal" ? { tor_team: billTo } : handle ? { userHandle: handle } : {}) }),
      });
      const d = await r.json();
      apply({
        role: "assistant",
        content: r.ok
          ? String(d.choices?.[0]?.message?.content ?? "…")
          : r.status === 402
            ? "Out of credits — subscribe to continue."
            : r.status === 401 ? "Sign in again to continue." : `Error: ${d.error?.message ?? "Request failed. Try again."}`,
        receipt: d.tor_receipt,
        settled: d.tor_settled,
        subscribeCta: r.status === 402,
      });
    } catch {
      apply({ role: "assistant", content: `Gateway unreachable (${GATEWAY}). Is it running?` });
    }
    setBusy(false);
  }

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-2xl items-center justify-between px-6">
          <Link href="/" >
            <Wordmark /></Link>
          <nav className="flex items-center gap-5 text-sm font-medium text-[#6E6E73]">
            <span className="text-black">Chat</span>
            <Link href="/network" className="hover:text-black">Network</Link>
            <Link href="/host" className="hover:text-black">Serve</Link>
          </nav>
          <LoginButton />
        </div>
      </header>
    <div className="mx-auto flex w-full max-w-[1200px] items-stretch gap-0 px-6">
      <aside className="hidden w-60 shrink-0 flex-col gap-4 border-r border-[#E5E5E0] py-6 pr-4 md:flex">
        <button onClick={newChat} className="h-9 rounded-full border border-black/10 text-sm hover:bg-black/5">
          + New chat
        </button>
        <div className="flex flex-col gap-4 overflow-y-auto">
          {[
            { label: "Today", items: threads.filter((t) => viewTime - t.updatedAt < 86_400_000) },
            { label: "Previous", items: threads.filter((t) => viewTime - t.updatedAt >= 86_400_000) },
          ].map(
            (g) =>
              g.items.length > 0 && (
                <div key={g.label} className="flex flex-col gap-1">
                  <span className="px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8F8F8F]">{g.label}</span>
                  {g.items.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => {
                        setCurrentId(t.id);
                        setInput("");
                      }}
                      className={`truncate rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-black/5 ${t.id === currentId ? "bg-black/5 font-medium" : "text-[#424242]"}`}
                      title={t.title}
                    >
                      {t.title}
                    </button>
                  ))}
                </div>
              ),
          )}
        </div>
        <p className="mt-auto px-2 font-mono text-[10px] leading-relaxed text-[#8F8F8F]">
          {handle ? "history follows your login" : "log in to keep history across browsers"}
        </p>
      </aside>
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-2xl flex-1 flex-col px-6">
      <div className="flex items-center justify-end gap-2 py-3">
        {teams.length > 0 && (
          <select value={billTo} onChange={(e) => setBillTo(e.target.value)} className="rounded-full border border-black/10 px-3 py-1 text-sm" aria-label="Bill to">
            <option value="personal">Personal credits</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.display_name} team credits</option>
            ))}
          </select>
        )}
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
            Every answer settles onchain, receipt hash below each reply. Prompts and completions stay off-chain.
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
                  {m.settled ? (
                    <>
                      ✓{" "}
                      <a
                        href={`/api/gw/api/receipts/${m.receipt}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open the receipt: both payment legs and the HCS sequence"
                        className="underline decoration-emerald-700/40 underline-offset-2 hover:decoration-emerald-700"
                      >
                        {m.receipt.slice(0, 12)}…
                      </a>{" "}
                      · settled ↗
                    </>
                  ) : (
                    <Link href="/onboarding" className="underline">demo reply — subscribe to settle onchain</Link>
                  )}
                </p>
              )}
              {m.subscribeCta && (
                <p className="m-0">
                  <Link href="/onboarding" className="rounded-full bg-black px-4 py-1.5 text-xs text-white">
                    Subscribe
                  </Link>
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
    </div>
  );
}
