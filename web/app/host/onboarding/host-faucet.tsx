"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useCallback, useEffect, useRef, useState } from "react";

export default function HostFaucet({ address, onFunded }: { address: string; onFunded: () => void }) {
  const { authenticated, getAccessToken } = usePrivy();
  const [state, setState] = useState<"idle" | "sending" | "pending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  const [transactionId, setTransactionId] = useState<string>();
  const active = useRef<AbortController | null>(null);
  const attempts = useRef(0);
  useEffect(() => () => active.current?.abort(), []);

  const claim = useCallback(async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setState("sending");
    setMessage("");
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Sign in again to get test HBAR.");
      const response = await fetch("/api/account/host-faucet", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ address }), signal: controller.signal,
      });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (result.transactionId) setTransactionId(result.transactionId);
      if (result.status === "failed") throw new Error("The transfer did not complete. Please use the Hedera faucet.");
      if (!response.ok) throw new Error(result.error?.message ?? "Funding is unavailable. Please try again.");
      if (result.status === "sent") {
        setState("sent");
        setMessage("5 testnet HBAR sent to this host. Your terminal can continue registration.");
        onFunded();
      } else {
        setState("pending");
        setMessage("Waiting for network confirmation. Checking again will not send a second transfer.");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setState("error");
      setMessage(error instanceof Error ? error.message : "Funding is unavailable. Please try again.");
    } finally { if (active.current === controller) active.current = null; }
  }, [address, getAccessToken, onFunded]);

  useEffect(() => {
    if (state !== "pending" || attempts.current >= 6) return;
    const timer = setTimeout(() => { attempts.current++; void claim(); }, 10000);
    return () => clearTimeout(timer);
  }, [state, claim]);

  return (
    <div className="mt-4 rounded-xl border border-black/10 bg-[#F7F7F5] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="m-0 text-sm font-medium">Get your host started</p>
          <p className="m-0 mt-1 text-xs text-[#6E6E73]">5 testnet HBAR from our pool · one host per account every 24 hours</p>
        </div>
        <button onClick={() => { attempts.current = 0; void claim(); }} disabled={!authenticated || state === "sending" || state === "sent"}
          className="h-10 shrink-0 rounded-full bg-black px-5 text-sm text-white hover:bg-zinc-800 disabled:opacity-40">
          {state === "sending" ? "Confirming transfer…" : state === "sent" ? "5 HBAR sent ✓" : state === "pending" || transactionId ? "Check transfer" : "Get HBAR from us"}
        </button>
      </div>
      {!authenticated && <p className="mb-0 mt-3 text-xs text-[#6E6E73]">Sign in above to use our funding pool.</p>}
      {message && <p role="status" className="mb-0 mt-3 text-sm text-[#5D5D5D]">{message}</p>}
      {transactionId && <a href={`https://hashscan.io/testnet/transaction/${encodeURIComponent(transactionId)}`} target="_blank" rel="noreferrer"
        className="mt-2 inline-block text-xs text-[#446DFF] underline">View transfer ↗</a>}
    </div>
  );
}
