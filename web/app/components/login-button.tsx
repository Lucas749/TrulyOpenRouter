"use client";

import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";

export default function LoginButton() {
  const { ready, authenticated, user, login } = usePrivy();

  if (!ready) {
    return (
      <button disabled className="h-10 rounded-full bg-zinc-200 px-5 text-sm text-zinc-500">
        …
      </button>
    );
  }
  if (authenticated) {
    return (
      <Link
        href="/account"
        title={`${user?.wallet?.address ?? ""} — account, log out inside`}
        className="flex h-10 items-center rounded-full border border-black/10 px-5 text-sm hover:bg-black/5"
      >
        {user?.wallet?.address?.slice(0, 6)}…{user?.wallet?.address?.slice(-4)}
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
