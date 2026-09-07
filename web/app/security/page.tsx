"use client";

import Link from "next/link";
import { MockBanner, useMock } from "../components/mock";
import TapQueue from "./taps";

export default function SecurityPage() {
  const [mock, toggleMock] = useMock();
  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      {mock && <MockBanner onOff={toggleMock} />}
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[720px] items-center justify-between px-6">
          <Link href="/account" className="text-sm text-[#6E6E73] hover:text-black">← Account</Link>
          <span className="text-[15px] font-semibold">Security</span>
          <span className="w-16" />
        </div>
      </header>
      <main className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-10">
        <div>
          <h1 className="m-0 text-2xl font-semibold">Security</h1>
          <p className="m-0 mt-1 text-sm text-[#6E6E73]">Dangerous server actions wait for a physical Ledger tap. This page is the queue.</p>
        </div>
        <TapQueue mock={mock} />
      </main>
    </div>
  );
}
