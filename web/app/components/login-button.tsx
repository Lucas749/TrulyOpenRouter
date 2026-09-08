"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useCreateWallet, usePrivy, useWallets } from "@privy-io/react-auth";

export default function LoginButton() {
  const { ready, authenticated, user, login } = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const [stuck, setStuck] = useState(false);
  const [creating, setCreating] = useState(false);
  const autoRef = useRef(false);

  // Privy usually readies in ~1s. Past 10s it never will this load
  // (blocked scripts, shields, or bad origin config) — say so plainly.
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setStuck(true), 10000);
    return () => clearTimeout(t);
  }, [ready]);

  // No click-to-create: the moment login lands without a wallet, provision one.
  // Guarded against double-fire (StrictMode + one header instance per page).
  const walletAddr = user?.wallet?.address ?? wallets[0]?.address;
  useEffect(() => {
    if (!ready || !authenticated || walletAddr || autoRef.current) return;
    autoRef.current = true;
    setCreating(true);
    createWallet()
      .catch(() => {
        autoRef.current = false; // let the user retry manually
      })
      .finally(() => setCreating(false));
  }, [ready, authenticated, walletAddr, createWallet]);

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
    const addr = walletAddr;
    if (!addr) {
      // Auto-provision runs above; this is only visible mid-flight or after a
      // failure (click retries). Never address slices of undefined.
      return (
        <button
          disabled={creating}
          onClick={() => {
            autoRef.current = false;
            setCreating(true);
            createWallet()
              .catch(() => {})
              .finally(() => setCreating(false));
          }}
          className="h-10 rounded-full border border-black/10 px-5 text-sm text-zinc-500 disabled:opacity-70"
        >
          {creating ? "creating wallet…" : "retry wallet"}
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
