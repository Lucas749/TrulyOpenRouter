"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import LoginButton from "../../components/login-button";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:4021";

function LinkInner() {
  const params = useSearchParams();
  const code = (params.get("code") ?? "").toUpperCase();
  const { ready, authenticated, user } = usePrivy();
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function approve() {
    const userId = user?.id;
    if (!userId || !code) return;
    setState("sending");
    try {
      const r = await fetch(`${GATEWAY}/api/device/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, userId }),
      });
      if (!r.ok) throw new Error((await r.json()).error?.message ?? r.status);
      setState("done");
      setMsg("host linked — back in your terminal, login completes automatically");
    } catch (e: any) {
      setState("error");
      setMsg(String(e?.message ?? e).slice(0, 160));
    }
  }

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/host" className="text-sm text-[#6E6E73] hover:text-black">← Serve</Link>
          <span className="text-[15px] font-semibold">Link host</span>
          <LoginButton />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col items-center gap-4 px-6 py-14 text-center">
        {!code ? (
          <p className="text-sm text-[#6E6E73]">No code — run <span className="font-mono text-black">tor-host login</span> in your terminal, then open the link it prints.</p>
        ) : !ready ? (
          <div className="h-10 w-48 animate-pulse rounded-full bg-[#F4F4F4]" />
        ) : !authenticated ? (
          <>
            <p className="m-0 font-mono text-3xl tracking-[0.2em]">{code}</p>
            <p className="m-0 text-sm text-[#6E6E73]">Log in to approve this host for your account.</p>
            <LoginButton />
          </>
        ) : state === "done" ? (
          <>
            <p className="m-0 font-mono text-3xl text-[#0B7A5D]">✓ linked</p>
            <p className="m-0 text-sm text-[#6E6E73]">{msg}</p>
          </>
        ) : (
          <>
            <p className="m-0 font-mono text-3xl tracking-[0.2em]">{code}</p>
            <button onClick={approve} disabled={state === "sending"} className="flex h-11 items-center rounded-full bg-black px-6 text-sm text-white disabled:opacity-50">
              {state === "sending" ? "approving…" : "Approve this host"}
            </button>
            {state === "error" && <p className="m-0 font-mono text-xs text-[#B3261E]">{msg}</p>}
          </>
        )}
      </main>
    </div>
  );
}

export default function HostLinkPage() {
  return (
    <Suspense>
      <LinkInner />
    </Suspense>
  );
}
