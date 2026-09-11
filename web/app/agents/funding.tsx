"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, parseEther } from "viem";
import { apiError } from "../../lib/api-error";
import { accountUrl, txUrl } from "../../lib/chain";
import { hederaTestnet } from "../../lib/hedera-chains";
import { friendlyTxError } from "../../lib/tx-errors";
import { useAuthFetch } from "../components/use-auth-fetch";

// Personal agent budget: you deposit HBAR into the agent's budget account from
// your own wallet, then buy vault credits the agent spends. Returning refunds
// unused credits and sends the HBAR back to one of your linked wallets; an agent
// with an enrolled Ledger needs that Ledger to approve the return.

interface FundingOp {
  id: string;
  kind: "buy_credits" | "return_funds";
  state: string;
  legs: { name: string; hash: string; status: string }[];
  terms: Record<string, string>;
  error: string | null;
  createdAt: number;
}

interface Quote {
  budgetAddress: string;
  planId: string;
  planCredits: string;
  priceHbar: string;
  gasReserveHbar: string;
  requiredHbar: string;
  balanceHbar: string;
  shortfallHbar: string;
  credits: string;
  openOperation: FundingOp | null;
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);
const hbar = (v: string) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });
const KIND_LABEL = { buy_credits: "Buy credits", return_funds: "Return funds" };

function stateTone(state: string): string {
  if (state === "confirmed") return "bg-[#E7F5EE] text-[#0B7A5D]";
  if (["reverted", "failed"].includes(state)) return "bg-[#FDECEA] text-[#B3261E]";
  return "bg-[#FDF3E2] text-[#8A5300]";
}

export default function AgentFunding({ agentId, ledgerAddress, ledgerSign }: { agentId: string; ledgerAddress: string | null; ledgerSign: (prompt: string, message: string) => Promise<string> }) {
  const authFetch = useAuthFetch();
  const { user } = usePrivy();
  const { wallets } = useWallets();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [operations, setOperations] = useState<FundingOp[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deposit, setDeposit] = useState("11");
  const [chosen, setChosen] = useState("");
  const base = `/api/gw/api/agents/${encodeURIComponent(agentId)}/funding`;
  const linked = ((user?.linkedAccounts ?? []) as Array<{ type: string; chainType?: string; address?: string }>)
    .filter((a) => a.type === "wallet" && a.chainType === "ethereum" && a.address)
    .map((a) => a.address!.toLowerCase());
  const destination = chosen || linked[0] || "";

  const load = useCallback(
    () =>
      authFetch(base).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(r.status === 501 ? "Agent funding is not available on this gateway yet." : apiError(d, r.status));
        setQuote(d.quote);
        setOperations(d.operations ?? []);
      }),
    [authFetch, base],
  );

  useEffect(() => {
    load().catch((e) => setErr(errorText(e)));
  }, [load]);

  async function run(tag: string, work: () => Promise<void>) {
    setBusy(tag);
    setErr(null);
    try {
      await work();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
      await load().catch(() => {});
    }
  }

  async function post(path: string, body: Record<string, unknown>) {
    const r = await authFetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(apiError(d, r.status));
    return d;
  }

  const depositFromMyWallet = () =>
    run("deposit", async () => {
      const wallet = wallets.find((w) => linked.includes(w.address.toLowerCase())) ?? wallets[0];
      if (!wallet || !quote) throw new Error("Connect a wallet to deposit, or send HBAR to the budget address.");
      try {
        await wallet.switchChain(hederaTestnet.id);
        const provider = await wallet.getEthereumProvider();
        const client = createWalletClient({ account: wallet.address as `0x${string}`, chain: hederaTestnet, transport: custom(provider) });
        await client.sendTransaction({ to: quote.budgetAddress as `0x${string}`, value: parseEther(deposit) });
      } catch (e) {
        throw new Error(`Deposit failed: ${friendlyTxError(e)}`);
      }
      await new Promise((r) => setTimeout(r, 6000)); // the relay reports the new balance after the next block
    });

  const buy = () => run("buy", () => post("/buy", { planId: Number(quote?.planId ?? 0) }).then(() => {}));

  const returnFunds = (to: string) =>
    run("return", async () => {
      if (!to) throw new Error("Link a wallet to your login to receive the returned HBAR.");
      let ledger: Record<string, string> | undefined;
      if (ledgerAddress) {
        const challenge = await post("/return/challenge", { destination: to });
        ledger = { message: challenge.message, token: challenge.token, signature: await ledgerSign("Approve returning this agent's funds on the enrolled Ledger", challenge.message) };
      }
      await post("/return", { destination: to, ...(ledger ? { ledger } : {}) });
    });

  const open = quote?.openOperation;
  const canBuy = !!quote && Number(quote.shortfallHbar) === 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-3">
      <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#5D5D5D]">Budget</span>
      {!quote ? (
        <span className="text-xs text-[#8F8F8F]">{err ?? "loading…"}</span>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-[#5D5D5D]">
            <a href={accountUrl(quote.budgetAddress)} target="_blank" rel="noreferrer" className="break-all underline">{quote.budgetAddress}</a>
            <span>{hbar(quote.balanceHbar)} HBAR</span>
            <span>{Number(quote.credits).toLocaleString("en-US")} credits</span>
            <span>
              plan {quote.planId}: {Number(quote.planCredits).toLocaleString("en-US")} credits for {hbar(quote.priceHbar)} HBAR + {hbar(quote.gasReserveHbar)} HBAR fee reserve
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" className="h-8 w-24 rounded-lg border border-black/10 px-2.5 font-mono text-xs" aria-label="Deposit amount in HBAR" />
            <button onClick={depositFromMyWallet} disabled={!!busy || !deposit.trim()} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">
              {busy === "deposit" ? "confirm in wallet…" : "Deposit HBAR"}
            </button>
            {open?.kind === "buy_credits" ? (
              <button onClick={buy} disabled={!!busy} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">{busy === "buy" ? "checking…" : "Check purchase"}</button>
            ) : (
              <button onClick={buy} disabled={!!busy || !canBuy || !!open} className="rounded-full bg-black px-3 py-1 text-[11px] text-white disabled:opacity-40">
                {busy === "buy" ? "buying…" : `Buy ${Number(quote.planCredits).toLocaleString("en-US")} credits`}
              </button>
            )}
            {!canBuy && !open && <span className="text-[11px] text-[#6E6E73]">deposit {hbar(quote.shortfallHbar)} more HBAR to buy</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {open?.kind === "return_funds" ? (
              <button onClick={() => returnFunds(open.terms.destination?.toLowerCase() ?? "")} disabled={!!busy} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">
                {busy === "return" ? "returning…" : `Continue return to ${open.terms.destination}`}
              </button>
            ) : (
              <>
                <select value={destination} onChange={(e) => setChosen(e.target.value)} className="h-8 max-w-full rounded-lg border border-black/10 bg-white px-2 font-mono text-[11px]" aria-label="Return destination">
                  {linked.map((w) => (
                    <option key={w} value={w}>{w}</option>
                  ))}
                </select>
                <button onClick={() => returnFunds(destination)} disabled={!!busy || !!open || !destination} className="rounded-full border border-black/10 px-3 py-1 text-[11px] disabled:opacity-40">
                  {busy === "return" ? (ledgerAddress ? "approve on Ledger…" : "returning…") : ledgerAddress ? "Return funds with Ledger" : "Return funds"}
                </button>
              </>
            )}
          </div>
          {operations.map((op) => (
            <div key={op.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[#5D5D5D]">
              <span>{new Date(op.createdAt).toISOString().replace("T", " ").slice(0, 16)}</span>
              <span>{KIND_LABEL[op.kind]}</span>
              <span className={`rounded-full px-2 py-0.5 ${stateTone(op.state)}`}>{op.state}</span>
              {op.kind === "buy_credits" && op.terms.creditsAfter && <span>{op.terms.creditsAfter} credits after</span>}
              {op.kind === "return_funds" && op.terms.returnedHbar && <span>{hbar(op.terms.returnedHbar)} HBAR returned</span>}
              {op.legs.map((l) => (
                <a key={l.hash} href={txUrl(l.hash)} target="_blank" rel="noreferrer" className="underline">{l.name} ↗</a>
              ))}
              {op.error && <span className="text-[#B3261E]">{op.error}</span>}
            </div>
          ))}
          {err && <span className="font-mono text-[11px] text-[#B3261E]">{err}</span>}
        </>
      )}
    </div>
  );
}
