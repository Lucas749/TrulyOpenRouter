"use client";

import { usePrivy } from "@privy-io/react-auth";

export default function LoginButton() {
  const { ready, authenticated, user, login, logout } = usePrivy();

  if (!ready) {
    return (
      <button disabled className="h-10 rounded-full bg-zinc-200 px-5 text-sm text-zinc-500">
        …
      </button>
    );
  }
  if (authenticated) {
    return (
      <button
        onClick={logout}
        title={user?.wallet?.address}
        className="h-10 rounded-full border border-black/10 px-5 text-sm hover:bg-black/5"
      >
        {user?.wallet?.address?.slice(0, 6)}…{user?.wallet?.address?.slice(-4)}
      </button>
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
