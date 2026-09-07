"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Banknote, Check, Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { MOCK_TAPS, MOCK_TAPS_META } from "../../lib/mock";

// Tap-gated action queue. Backend owns all trust: this UI renders the tap
// list, shows the device instruction verbatim, and relays Verify/Execute.
// It never signs anything — buttons say Verify / Execute, never "Sign".

interface Tap {
  id: string;
  kind: "heartbeat" | "stake-release";
  params: Record<string, string>;
  actionHash: string;
  approveMemo: string;
  approveAmountTinybar: number;
  status: "pending" | "approved" | "executed" | "failed";
  createdAt: number;
  tapTx?: string;
  tapSigner?: string;
  execTx?: string;
  execError?: string;
  deviceInstruction?: string; // only on queue response, not list rows
}

const PILL: Record<Tap["status"], string> = {
  pending: "bg-[#FDF3E2] text-[#8A5300]",
  approved: "bg-[#E7F5EE] text-[#0B7A5D]",
  executed: "bg-[#F4F4F4] text-[#0D0D0D]",
  failed: "bg-[#FDECEA] text-[#B3261E]",
};

const KIND_LABEL: Record<Tap["kind"], string> = {
  heartbeat: "Heartbeat as host",
  "stake-release": "Release staked HBAR",
};

function KindIcon({ kind }: { kind: Tap["kind"] }) {
  return kind === "heartbeat" ? <Activity size={14} /> : <Banknote size={14} />;
}

function age(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatHbar(tinybar: number): string {
  return (tinybar / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0");
}

function hashscanTx(id: string): string {
  return `https://hashscan.io/testnet/transaction/${id}`;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        try {
          navigator.clipboard?.writeText(text).catch(() => {});
        } catch {}
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="inline-flex h-[26px] items-center gap-1 rounded-full border border-black/10 bg-white px-2.5 text-[11px] text-[#424242] hover:bg-[#F4F4F4]"
      title={label}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

export default function TapQueue({ mock }: { mock: boolean }) {
  const [taps, setTaps] = useState<Tap[] | null>(null);
  const [ringBackend, setRingBackend] = useState<string | null>(null);
  const [tapAccount, setTapAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmExec, setConfirmExec] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (mock) {
      setTaps(MOCK_TAPS);
      setRingBackend(MOCK_TAPS_META.ringBackend);
      setTapAccount(MOCK_TAPS_META.tapAccount);
      return;
    }
    try {
      const d: any = await (await fetch("/api/security/taps")).json();
      setTaps(d.taps ?? []);
      setRingBackend(d.ringBackend ?? null);
      setTapAccount(d.tapAccount ?? null);
      if (d.error) setErr(String(d.error).slice(0, 200));
    } catch {
      setTaps([]);
    }
  }, [mock]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id: string, action: "verify" | "execute", tag: string) {
    setBusy(tag);
    setErr(null);
    try {
      const r = await fetch(`/api/security/taps/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? r.status);
      setConfirmExec(null);
      await load();
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 200));
    } finally {
      setBusy(null);
    }
  }

  async function queue(kind: Tap["kind"]) {
    setBusy(`queue-${kind}`);
    setErr(null);
    try {
      const r = await fetch("/api/security/taps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? r.status);
      await load();
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 200));
    } finally {
      setBusy(null);
    }
  }

  const pending = (taps ?? []).filter((t) => t.status === "pending" || t.status === "approved");
  const history = (taps ?? []).filter((t) => t.status === "executed" || t.status === "failed").slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2 rounded-[14px] border border-[#E5E5E0] p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={15} />
          <span className="text-sm font-semibold">Device-backed trust</span>
          {ringBackend === "ring" ? (
            <span className="ml-auto rounded-full bg-[#E7F5EE] px-2.5 py-0.5 text-[11px] text-[#0B7A5D]">Ledger ring</span>
          ) : ringBackend ? (
            <span className="ml-auto rounded-full bg-[#FDF3E2] px-2.5 py-0.5 text-[11px] text-[#8A5300]">env fallback</span>
          ) : (
            <span className="ml-auto font-mono text-[11px] text-[#8F8F8F]">…</span>
          )}
        </div>
        <p className="m-0 text-sm text-[#6E6E73]">Withdrawals and stake releases execute only after a Ledger-signed approval.</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-[#8F8F8F]">Tap signer</span>
          {tapAccount ? (
            <>
              <span className="font-mono text-xs">{tapAccount}</span>
              <CopyButton text={tapAccount} label="copy tap signer account" />
            </>
          ) : (
            <span className="font-mono text-xs text-[#8F8F8F]">—</span>
          )}
          {ringBackend === "env" && <span className="text-[11px] text-[#8A5300]">No ring configured — falling back to the env key</span>}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="m-0 text-sm font-semibold">Pending queue</h2>
          <span className="font-mono text-[11px] text-[#8F8F8F]">{pending.length}</span>
          {!mock && (
            <span className="ml-auto flex gap-2">
              <button onClick={() => queue("heartbeat")} disabled={busy === "queue-heartbeat"} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">
                {busy === "queue-heartbeat" ? "queuing…" : "Queue heartbeat"}
              </button>
              <button onClick={() => queue("stake-release")} disabled={busy === "queue-stake-release"} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">
                {busy === "queue-stake-release" ? "queuing…" : "Queue release"}
              </button>
            </span>
          )}
        </div>
        {pending.map((t) => (
          <div key={t.id} className={`flex flex-col gap-2 rounded-xl border p-4 ${t.status === "approved" ? "border-[#10A37F] bg-[#F4FBF8]" : "border-[#E5E5E0]"}`}>
            <div className="flex items-center gap-2">
              <KindIcon kind={t.kind} />
              <span className="text-sm font-medium">{KIND_LABEL[t.kind]}</span>
              <span className="font-mono text-[11px] text-[#8F8F8F]">{age(t.createdAt)}</span>
              <span className={`ml-auto rounded-full px-2.5 py-0.5 text-[11px] ${PILL[t.status]}`}>{t.status}</span>
            </div>
            <div className="font-mono text-[11px] text-[#6E6E73]">
              {Object.entries(t.params).map(([k, v]) => `${k} ${v}`).join(" · ")}
              {Object.keys(t.params).length > 0 ? " · " : ""}action {t.actionHash.slice(0, 18)}…
            </div>
            {t.status === "pending" && (
              <>
                <div className="rounded-lg bg-[#F7F7F5] p-3">
                  <p className="m-0 mb-2 font-mono text-xs">
                    {t.deviceInstruction ??
                      `In Ledger Live (HBAR app): send exactly ${formatHbar(t.approveAmountTinybar)} HBAR from ${tapAccount ?? "your tap account"} to yourself, then come back and hit Verify`}
                  </p>
                  <CopyButton
                    text={t.deviceInstruction ?? `send exactly ${formatHbar(t.approveAmountTinybar)} HBAR to yourself`}
                    label="copy device instruction"
                  />
                </div>
                <p className="m-0 text-[11px] text-[#6E6E73]">1 Send the exact amount in Ledger Live (HBAR app) · 2 Approve on your Ledger · 3 Come back, hit Verify</p>
                <div>
                  <button
                    onClick={() => act(t.id, "verify", `verify-${t.id}`)}
                    disabled={mock || busy === `verify-${t.id}`}
                    title={mock ? "mock" : undefined}
                    className="rounded-full bg-black px-4 py-1.5 text-xs text-white disabled:opacity-40"
                  >
                    {busy === `verify-${t.id}` ? "checking mirror node…" : "Verify"}
                  </button>
                </div>
              </>
            )}
            {t.status === "approved" && !mock && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#0B7A5D]">
                  <span>
                    approved by {t.tapSigner} ·{" "}
                    <a href={hashscanTx(t.tapTx ?? "")} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[#2563EB] underline">
                      tap {t.tapTx} <ExternalLink size={10} />
                    </a>
                  </span>
                </div>
                {confirmExec === t.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px]">This sends a real testnet transaction.</span>
                    <button onClick={() => act(t.id, "execute", `exec-${t.id}`)} disabled={busy === `exec-${t.id}`} className="rounded-full bg-black px-4 py-1.5 text-xs text-white disabled:opacity-40">
                      {busy === `exec-${t.id}` ? "executing…" : "Confirm execute"}
                    </button>
                    <button onClick={() => setConfirmExec(null)} className="text-[11px] text-[#6E6E73] underline">cancel</button>
                  </div>
                ) : (
                  <div>
                    <button onClick={() => setConfirmExec(t.id)} className="rounded-full bg-black px-4 py-1.5 text-xs text-white">
                      Execute on Hedera
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {taps && !pending.length && (
          <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-black/15 py-8 text-center">
            <ShieldCheck size={18} className="text-[#8F8F8F]" />
            <span className="text-sm font-medium">No actions waiting</span>
            <span className="text-xs text-[#8F8F8F]">Nothing needs your Ledger right now.</span>
          </div>
        )}
        {taps === null && <p className="m-0 text-sm text-[#8F8F8F]">loading queue…</p>}
      </section>

      {(history.length > 0 || (taps && taps.length > 0)) && (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="m-0 text-sm font-semibold">History</h2>
            <span className="font-mono text-[11px] text-[#8F8F8F]">Newest first · older in logs</span>
          </div>
          {history.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[#F7F7F5] px-3 py-2">
              <KindIcon kind={t.kind} />
              <span className="text-xs font-medium">{KIND_LABEL[t.kind]}</span>
              <span className="font-mono text-[11px] text-[#8F8F8F]">{age(t.createdAt)}</span>
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${PILL[t.status]}`}>{t.status}</span>
              {t.tapSigner && <span className="font-mono text-[11px] text-[#6E6E73]">signer {t.tapSigner}</span>}
              {t.tapTx && (
                <a href={hashscanTx(t.tapTx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-[11px] text-[#2563EB] underline">
                  tap {t.tapTx.length > 24 ? `${t.tapTx.slice(0, 24)}…` : t.tapTx} <ExternalLink size={10} />
                </a>
              )}
              {t.execTx ? (
                <a href={hashscanTx(t.execTx)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-[11px] text-[#2563EB] underline">
                  exec {t.execTx.slice(0, 10)}… <ExternalLink size={10} />
                </a>
              ) : (
                t.status === "executed" && <span className="font-mono text-[11px] text-[#8F8F8F]">exec —</span>
              )}
              {t.execError && <span className="w-full font-mono text-[11px] text-[#B3261E]">{t.execError}</span>}
            </div>
          ))}
          {!history.length && <p className="m-0 text-xs text-[#8F8F8F]">nothing decided yet</p>}
        </section>
      )}
      {err && <p className="m-0 font-mono text-xs text-[#B3261E]">{err}</p>}
      <p className="m-0 text-[11px] leading-relaxed text-[#8F8F8F]">
        Approvals are exact-amount HBAR transfers to your own Hedera account, signed on your Ledger (testnet = faucet money). Execution is a Hedera testnet
        transaction with the ring-held host key.
      </p>
    </div>
  );
}
