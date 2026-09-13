"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

// Mock toggle: ?mock=1 in URL (persisted to localStorage). Default OFF, real data only.
// When ON, every data surface switches ENTIRELY to mock.ts fixtures and shows the banner.
const KEY = "tor-mock";

// Demo mode (?demo=1): a visitor who has not signed up browses the signed-in surfaces.
// It IMPLIES mock, so no live figure is ever shown, and it additionally hands pages a
// stand-in identity (DEMO_ME) so anything gated on a Privy login renders instead of
// asking them to log in. Nothing can be executed: every write path is already hidden or
// short-circuited while mock is on, and no request carries a token.
const DEMO_KEY = "tor-demo";

/// @notice The stand-in identity demo mode gives pages that expect a Privy login.
export const DEMO_ME = {
  did: "did:privy:demo",
  wallet: "0xDe11000000000000000000000000000000000A11",
  email: null as string | null,
};

/// @notice Resolve a URL-or-localStorage flag. `?x=1` sets it, `?x=0` clears it, bare
/// navigation keeps whatever was persisted.
function resolveFlag(key: string, param: string): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get(param) === "0") {
    try {
      window.localStorage.removeItem(key);
    } catch {}
    return false;
  }
  if (params.get(param) === "1") {
    try {
      window.localStorage.setItem(key, "1");
    } catch {}
    return true;
  }
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function useMock(): [boolean, () => void] {
  const [mock, setMock] = useState(false);
  useEffect(() => {
    // Demo rides on mock: an explorer must never be shown a live figure.
    setMock(resolveFlag(KEY, "mock") || resolveFlag(DEMO_KEY, "demo"));
  }, []);
  const toggle = useCallback(() => {
    setMock((m) => {
      try {
        window.localStorage.setItem(KEY, m ? "0" : "1");
      } catch {}
      return !m;
    });
  }, []);
  return [mock, toggle];
}

/// @notice Demo mode and a setter. Setting it reloads, which is what re-seeds every
/// page's data from fixtures in one step rather than threading state through the tree.
export function useDemo(): [boolean, (on: boolean) => void] {
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    setDemo(resolveFlag(DEMO_KEY, "demo"));
  }, []);
  const set = useCallback((on: boolean) => {
    try {
      window.localStorage.setItem(DEMO_KEY, on ? "1" : "0");
      window.localStorage.setItem(KEY, on ? "1" : "0");
    } catch {}
    window.location.href = on ? window.location.pathname : "/";
  }, []);
  return [demo, set];
}

export function MockBanner({ onOff }: { onOff: () => void }) {
  return (
    <div className="flex w-full items-center justify-center gap-3 bg-amber-100 px-4 py-1.5 text-xs text-amber-900">
      <span className="font-mono">MOCK DATA, figures on this page are fixtures, not live</span>
      <button onClick={onOff} className="underline">
        show real data
      </button>
    </div>
  );
}

/// @notice Shown to a signed-out visitor: the way into demo mode without signing up.
export function DemoInvite({ onOn }: { onOn: () => void }) {
  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-2 bg-[#EFF4FF] px-4 py-1.5 text-xs text-[#1E40AF]">
      <span>Want to explore? See the whole product with sample data, no sign-up needed.</span>
      <button
        onClick={() => onOn()}
        className="rounded-full bg-[#2563EB] px-3 py-1 font-medium text-white hover:bg-[#1D4ED8]"
      >
        Demo mode
      </button>
    </div>
  );
}

/// @notice Shown on every page while demo mode is on.
export function DemoBanner({ onOff }: { onOff: () => void }) {
  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-2 bg-[#EFF4FF] px-4 py-1.5 text-xs text-[#1E40AF]">
      <span>
        <span className="font-medium">You&apos;re in demo mode.</span> Sample data, nothing here can be executed.
      </span>
      <Link href="/onboarding" className="rounded-full bg-[#2563EB] px-3 py-1 font-medium text-white hover:bg-[#1D4ED8]">
        Sign up for the real thing
      </Link>
      <button onClick={() => onOff()} className="underline">
        leave demo
      </button>
    </div>
  );
}

/// @notice The one banner every page renders: demo wins over mock, neither shows by default.
export function TopBanner({
  mock,
  demo,
  onOffMock,
  onOffDemo,
}: {
  mock: boolean;
  demo: boolean;
  onOffMock: () => void;
  onOffDemo: (on: boolean) => void;
}) {
  if (demo) return <DemoBanner onOff={() => onOffDemo(false)} />;
  if (mock) return <MockBanner onOff={onOffMock} />;
  return null;
}
