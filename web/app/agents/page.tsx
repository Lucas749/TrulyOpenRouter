"use client";

import Link from "next/link";
import LoginButton from "../components/login-button";
import { Wordmark } from "../components/mark";
import AgentsPanel from "./agents-panel";

// Agents have their own page for deep links; the same panel also lives under Account.

export default function AgentsPage() {
  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[960px] items-center justify-between px-6">
          <Link href="/account" className="text-sm text-[#6E6E73] hover:text-black">← Account</Link>
          <Wordmark size={22} />
          <LoginButton />
        </div>
      </header>
      <main className="mx-auto flex max-w-[960px] flex-col gap-6 px-6 py-10">
        <AgentsPanel />
      </main>
    </div>
  );
}
