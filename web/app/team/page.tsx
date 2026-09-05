"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Org {
  id: string;
  display_name: string;
  default_key_quorum_id: string;
}

export default function TeamPage() {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [name, setName] = useState("");
  const [cap, setCap] = useState("0.5");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [created, setCreated] = useState<any | null>(null);

  async function load() {
    try {
      const r: any = await (await fetch("/api/team/orgs")).json();
      setOrgs(r.data ?? []);
    } catch {
      setOrgs([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    setCreated(null);
    try {
      const capWei = cap.trim() ? String(BigInt(Math.round(Number(cap) * 1e6)) * BigInt(1e12)) : undefined;
      const r = await fetch("/api/team/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), ...(capWei ? { capWei } : {}) }),
      });
      const d: any = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.status);
      setCreated(d);
      setName("");
      await load();
    } catch (e: any) {
      setMsg(String(e?.message ?? e).slice(0, 200));
    }
    setBusy(false);
  }

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/account" className="text-sm text-[#6E6E73] hover:text-black">← Account</Link>
          <span className="text-[15px] font-semibold">Team pools</span>
          <span className="w-16" />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-10">
        <p className="m-0 text-sm text-[#6E6E73]">Shared wallets with quorum ownership. Creating a team provisions key quorum → organization → wallet in one call.</p>
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" className="h-10 flex-[2] rounded-lg border border-black/10 px-3 text-sm" />
          <input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="cap ETH" className="h-10 flex-1 rounded-lg border border-black/10 px-3 font-mono text-sm" inputMode="decimal" />
          <button onClick={create} disabled={busy || !name.trim()} className="h-10 rounded-full bg-black px-5 text-sm text-white disabled:opacity-40">{busy ? "creating…" : "Create team"}</button>
        </div>
        {msg && <p className="m-0 font-mono text-xs text-[#B3261E]">{msg}</p>}
        {created && (
          <div className="flex flex-col gap-1.5 rounded-[14px] border border-[#10A37F] p-4 font-mono text-xs">
            <span className="text-[#0B7A5D]">✓ team live — quorum → org → wallet</span>
            <span>org {created.org.id}</span>
            <span>wallet {created.wallet.address}</span>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Teams ({orgs?.length ?? "…"})</span>
          {(orgs ?? []).map((o) => (
            <div key={o.id} className="flex flex-wrap items-center gap-x-3 rounded-xl border border-[#E5E5E0] px-4 py-2.5 text-sm">
              <span className="font-medium">{o.display_name}</span>
              <span className="font-mono text-xs text-[#6E6E73]">{o.id}</span>
              <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">quorum {o.default_key_quorum_id.slice(0, 10)}…</span>
            </div>
          ))}
          {orgs && !orgs.length && <p className="m-0 text-sm text-[#8F8F8F]">no teams yet — create the first above</p>}
        </div>
        <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">policies attach per wallet next (spending caps, allowlists); intents drive multi-party approvals after that.</p>
      </main>
    </div>
  );
}
