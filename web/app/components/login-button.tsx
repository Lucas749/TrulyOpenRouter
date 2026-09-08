"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCreateWallet, usePrivy } from "@privy-io/react-auth";

export default function LoginButton() {
  const { ready, authenticated, user, login } = usePrivy();
  const { createWallet } = useCreateWallet();
  const [stuck, setStuck] = useState(false);
  const [creating, setCreating] = useState(false);

  // Privy usually readies in ~1s. Past 10s it never will this load
  // (blocked scripts, shields, or bad origin config) — say so plainly.
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setStuck(true), 10000);
    return () => clearTimeout(t);
  }, [ready]);

  if (!ready) {
    return (
      <button
        disabled={!stuck}
        onClick={() => window.location.reload()}
        title={stuck ? "Login isn't loading — click to retry. Still stuck? Disable shields/ad-block for this site, or check the Privy app allows this origin." : undefined}
        className="h-10 rounded-full bg-zinc-200 px-5 text-sm text-zinc-500"
      >
        {stuck ? "retry login" : "…"}
      </button>
    );
  }
  if (authenticated) {
    const addr = user?.wallet?.address;
    if (!addr) {
      // Logged in but no embedded wallet yet: Privy doesn't always auto-create.
      // One click provisions it (the old pill just waited here forever).
      return (
        <button
          disabled={creating}
          onClick={async () => {
            setCreating(true);
            try {
              await createWallet();
            } catch {}
            setCreating(false);
          }}
          className="h-10 rounded-full bg-black px-5 text-sm text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {creating ? "creating wallet…" : "Create wallet"}
        </button>
      );
    }
    return (
      <Link
        href="/account"
        title={`${addr} — account, log out inside`}
        className="flex h-10 items-center rounded-full border border-black/10 px-5 text-sm hover:bg-black/5"
      >
        {addr.slice(0, 6)}…{addr.slice(-4)}
      </Link>
    );
  }
  return (
    <button
      onClick={login}
      className="h-10 rounded-full bg-black px-5 text-sm text-white hover:bg-zinc-800"
    >
      Log in
    </button>
  );
}
