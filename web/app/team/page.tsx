"use client";

import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { DEMO_ME, TopBanner, useDemo, useMock } from "../components/mock";
import TeamOrgs from "./orgs";

export default function TeamPage() {
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const [mock, toggleMock] = useMock();
  const [demo, setDemo] = useDemo();
  // Demo mode stands in for a login so a visitor can read the team surfaces.
  const me = user
    ? { did: user.id, wallet: wallets[0]?.address ?? user?.wallet?.address ?? null, email: (user as any)?.email?.address ?? (user as any)?.google?.email ?? null }
    : demo
      ? DEMO_ME
      : null;

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <TopBanner mock={mock} demo={demo} onOffMock={toggleMock} onOffDemo={setDemo} />
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between px-6">
          <Link href="/account" className="text-sm text-[#6E6E73] hover:text-black">← Account</Link>
          <span className="text-[15px] font-semibold">Team pools</span>
          <span className="w-16" />
        </div>
      </header>
      <main className="mx-auto flex max-w-[1240px] flex-col gap-6 px-6 py-10">
        <TeamOrgs me={me} mock={mock} />
      </main>
    </div>
  );
}
