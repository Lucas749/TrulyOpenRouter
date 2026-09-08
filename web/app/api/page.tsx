"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const GATEWAY = "/api/gw"; // same-origin proxy, never localhost (browser prompt + mixed content)

interface StoredKey {
  prefix: string;
  created: number;
  models: string[];
}

export default function ApiKeysPage() {
  const [models, setModels] = useState("");
  const [expiryDays, setExpiryDays] = useState("30");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [keys, setKeys] = useState<StoredKey[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    try {
      setKeys(JSON.parse(window.localStorage.getItem("tor-keys") ?? "[]"));
    } catch {}
  }, []);

  useEffect(() => {
    (async () => {
      const u: Record<string, number> = {};
      for (const k of keys) {
        try {
          const r: any = await (await fetch(`${GATEWAY}/api/users/key:${k.prefix}/receipts`)).json();
          u[k.prefix] = (r.data ?? []).length;
        } catch {}
      }
      setUsage(u);
    })();
  }, [keys]);

  function persist(next: StoredKey[]) {
    setKeys(next);
    try {
      window.localStorage.setItem("tor-keys", JSON.stringify(next));
    } catch {}
  }

  async function create() {
    setMsg(null);
    setRevealed(null);
    const scopes: any = {};
    const ms = models.split(",").map((s) => s.trim()).filter(Boolean);
    if (ms.length) scopes.models = ms;
    const days = Number(expiryDays);
    if (days > 0) scopes.expiresAt = Date.now() + days * 86_400_000;
    try {
      const r: any = await (
        await fetch(`${GATEWAY}/api/keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopes }),
        })
      ).json();
      if (!r.key) throw new Error(r.error?.message ?? "issue failed");
      setRevealed(r.key);
      persist([{ prefix: r.prefix, created: Date.now(), models: ms }, ...keys]);
    } catch (e: any) {
      setMsg(`create failed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }

  async function revoke(prefix: string) {
    await fetch(`${GATEWAY}/api/keys/${prefix}`, { method: "DELETE" });
    persist(keys.filter((k) => k.prefix !== prefix));
  }

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/account" className="text-sm text-[#6E6E73] hover:text-black">← Account</Link>
          <span className="text-[15px] font-semibold">API keys</span>
          <span className="w-16" />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-10">
        <div className="flex flex-col gap-3 rounded-[14px] border border-[#E5E5E0] p-5">
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">New key</span>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[#6E6E73]">Models allowlist, comma-separated (blank = all)</span>
            <input value={models} onChange={(e) => setModels(e.target.value)} placeholder="qwen2.5:0.5b" className="h-10 rounded-lg border border-black/10 px-3 font-mono text-[13px]" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[#6E6E73]">Expires in days (0 = never)</span>
            <input value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} className="h-10 rounded-lg border border-black/10 px-3 font-mono text-[13px]" inputMode="numeric" />
          </label>
          <button onClick={create} className="flex h-10 items-center justify-center rounded-full bg-black text-sm text-white hover:bg-zinc-800">Create key</button>
          {msg && <p className="m-0 font-mono text-xs text-[#B3261E]">{msg}</p>}
          {revealed && (
            <div className="flex flex-col gap-1.5 rounded-lg bg-[#0D0D0D] p-4">
              <span className="text-[11px] uppercase tracking-[0.1em] text-[#8B95A5]">shown once, copy now</span>
              <span className="break-all font-mono text-xs text-[#E6EAF0]">{revealed}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Keys in this browser ({keys.length})</span>
          {keys.length ? (
            keys.map((k) => (
              <div key={k.prefix} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#E5E5E0] px-4 py-2.5 font-mono text-xs">
                <span>{k.prefix}…</span>
                <span className="text-[#6E6E73]">{k.models.length ? k.models.join(", ") : "all models"}</span>
                <span className="text-[#6E6E73]">{usage[k.prefix] ?? "…"} calls</span>
                <button onClick={() => revoke(k.prefix)} className="ml-auto text-[#B3261E] underline">revoke</button>
              </div>
            ))
          ) : (
            <p className="m-0 text-sm text-[#8F8F8F]">no keys yet, create one above. Keys live in this browser; the gateway never stores plaintext.</p>
          )}
        </div>
      </main>
    </div>
  );
}
