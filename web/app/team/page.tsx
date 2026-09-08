"use client";

import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { MockBanner, useMock } from "../components/mock";
import TeamOrgs from "./orgs";

export default function TeamPage() {
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const [mock, toggleMock] = useMock();
  const me = user ? { did: user.id, wallet: wallets[0]?.address ?? user?.wallet?.address ?? null } : null;

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      {mock && <MockBanner onOff={toggleMock} />}
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/account" className="text-sm text-[#6E6E73] hover:text-black">← Account</Link>
          <span className="text-[15px] font-semibold">Team pools</span>
          <span className="w-16" />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-10">
        <p className="m-0 text-sm text-[#6E6E73]">Shared wallets with quorum ownership. Creating a team provisions key quorum → organization → wallet in one call.</p>
        <TeamOrgs me={me} mock={mock} />
        <p className="m-0 font-mono text-[11px] text-[#8F8F8F]">approvals behind the button: propose → server-held quorum key authorizes → auto-executes. Server keys exist for teams created after the key-store change; older teams show the approve error with the fix.</p>
      </main>
    </div>
  );
}
