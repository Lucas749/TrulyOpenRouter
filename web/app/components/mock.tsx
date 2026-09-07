"use client";

import { useCallback, useEffect, useState } from "react";

// Mock toggle: ?mock=1 in URL (persisted to localStorage). Default OFF — real data only.
// When ON, every data surface switches ENTIRELY to mock.ts fixtures and shows the banner.
const KEY = "tor-mock";

export function useMock(): [boolean, () => void] {
  const [mock, setMock] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Explicit ?mock=0 clears the persisted flag; bare navigation keeps it.
    if (params.get("mock") === "0") {
      setMock(false);
      try {
        window.localStorage.removeItem(KEY);
      } catch {}
    } else if (params.get("mock") === "1") {
      setMock(true);
      try {
        window.localStorage.setItem(KEY, "1");
      } catch {}
    } else {
      try {
        if (window.localStorage.getItem(KEY) === "1") setMock(true);
      } catch {}
    }
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

export function MockBanner({ onOff }: { onOff: () => void }) {
  return (
    <div className="flex w-full items-center justify-center gap-3 bg-amber-100 px-4 py-1.5 text-xs text-amber-900">
      <span className="font-mono">MOCK DATA — figures on this page are fixtures, not live</span>
      <button onClick={onOff} className="underline">
        show real data
      </button>
    </div>
  );
}
