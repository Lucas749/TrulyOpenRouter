"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useConnectWallet, usePrivy, useWallets } from "@privy-io/react-auth";
import { createPublicClient, createWalletClient, custom, formatEther, http, parseAbi } from "viem";
import { hederaTestnet } from "../../lib/hedera-chains";
import LoginButton from "../components/login-button";
import { contractUrl } from "../../lib/chain";
import { friendlyTxError } from "../../lib/tx-errors";
import { Wordmark } from "../components/mark";

const VAULT = "0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576";
const PLAN_ID = 0;
const PLAN_PRICE_WEI = BigInt(10_000_000_000_000_000_000); // 10 HBAR sent
const PLAN_PRICE_HBAR = 10;
const NEEDED_HBAR = 10.5; // plan price plus room for the network fee
const PLAN_CREDITS = 10_000;
const RPC = "https://testnet.hashio.io/api";

const VAULT_ABI = parseAbi([
  "function subscribe(uint256) payable",
  "function credits(address) view returns (uint256)",
]);

const secondary =
  "flex h-9 items-center rounded-full border border-black/10 bg-white px-4 text-[13px] text-[#0D0D0D] transition-colors hover:bg-[#F7F7F5] disabled:opacity-40";
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function readAccount(address: `0x${string}`) {
  const client = createPublicClient({ transport: http(RPC) });
  const [credits, balance] = await Promise.all([
    client.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "credits", args: [address] }),
    client.getBalance({ address }),
  ]);
  return { credits: String(credits), hbar: Number(formatEther(balance)) };
}

type StepState = "done" | "active" | "upcoming";

function Step({ n, state, title, hint, last, children }: { n: number; state: StepState; title: string; hint?: string; last?: boolean; children?: ReactNode }) {
  return (
    <li className="relative flex gap-4">
      {!last && <span aria-hidden className={`absolute bottom-0 left-4 top-10 w-px -translate-x-1/2 ${state === "done" ? "bg-[#0D0D0D]" : "bg-[#E5E5E0]"}`} />}
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium ${
          state === "done" ? "bg-[#0D0D0D] text-white" : state === "active" ? "border-2 border-[#0D0D0D]" : "border border-[#D4D4CF] text-[#8F8F8F]"
        }`}
      >
        {state === "done" ? "✓" : n}
      </span>
      <div className={`flex min-w-0 flex-1 flex-col gap-3 ${last ? "" : "pb-10"}`}>
        <div className="flex flex-col gap-0.5 pt-1">
          <h2 className={`m-0 text-[17px] font-medium ${state === "upcoming" ? "text-[#8F8F8F]" : ""}`}>{title}</h2>
          {hint && <p className="m-0 text-sm text-[#6E6E73]">{hint}</p>}
        </div>
        {children}
      </div>
    </li>
  );
}

export default function OnboardingPage() {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const [account, setAccount] = useState<{ credits: string; hbar: number } | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "success" | "error"; text: string } | null>(null);
  const [drip, setDrip] = useState<"idle" | "sending" | "done" | "used">("idle");
  const [copied, setCopied] = useState(false);

  const wallet = wallets[0];
  const address = (user?.wallet?.address ?? wallet?.address) as `0x${string}` | undefined;

  // Read balance and credits as soon as the wallet is known, and keep them current while funding.
  useEffect(() => {
    if (!authenticated || !address) return;
    let live = true;
    const read = () =>
      readAccount(address).then(
        (a) => {
          if (!live) return;
          setAccount(a);
          setReadFailed(false);
        },
        () => {
          if (live) setReadFailed(true);
        },
      );
    read();
    const timer = setInterval(read, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [authenticated, address, tick]);

  async function dripFunds() {
    if (!address) return;
    setDrip("sending");
    setMsg(null);
    try {
      const r = await fetch("/api/account/drip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.status === 409) {
        setDrip("used");
        setMsg({ tone: "info", text: "This address already received its 0.5 HBAR. Use the faucet for the rest." });
      } else if (!r.ok) {
        throw new Error(d.error ?? String(r.status));
      } else {
        setDrip("done");
        setMsg({ tone: "success", text: "0.5 HBAR is on its way. Your balance updates here on its own." });
      }
    } catch (e) {
      setDrip("idle");
      setMsg({ tone: "error", text: `Could not send test HBAR: ${friendlyTxError(e)}` });
    }
  }

  function copy() {
    if (!address) return;
    (navigator.clipboard?.writeText(address) ?? Promise.reject()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setMsg({ tone: "error", text: "Copy failed. Select the address manually." }),
    );
  }

  async function subscribe() {
    if (!wallet || !address) {
      setMsg({ tone: "info", text: "Your wallet is still being created. Try again in a few seconds." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await wallet.switchChain(hederaTestnet.id);
      const provider = await wallet.getEthereumProvider();
      const walletClient = createWalletClient({ account: address, chain: hederaTestnet, transport: custom(provider) });
      const hash = await walletClient.writeContract({ address: VAULT, abi: VAULT_ABI, functionName: "subscribe", args: [BigInt(PLAN_ID)], value: PLAN_PRICE_WEI });
      setMsg({ tone: "success", text: `Subscribed. Transaction ${hash.slice(0, 10)}… is confirming; your credits appear in a moment.` });
      setTimeout(() => setTick((t) => t + 1), 4000);
    } catch (e) {
      setMsg({ tone: "error", text: `Subscription failed: ${friendlyTxError(e)}` });
    }
    setBusy(false);
  }

  const hbar = account?.hbar ?? null;
  const subscribed = !!account && account.credits !== "0";
  const funded = hbar !== null && hbar >= NEEDED_HBAR;
  const step = !authenticated ? 1 : subscribed ? 3 : 2;
  const stateOf = (n: number): StepState => (n < step ? "done" : n === step ? "active" : "upcoming");
  const tone = { info: "bg-[#F7F7F5] text-[#5D5D5D]", success: "bg-[#E7F5EE] text-[#0B7A5D]", error: "bg-[#FDECEA] text-[#B3261E]" };

  return (
    <div className="min-h-screen bg-white font-sans text-[#0D0D0D]">
      <header className="sticky top-0 z-30 border-b border-[#E5E5E0] bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[640px] items-center justify-between px-6">
          <Link href="/" >
            <Wordmark />
          </Link>
          <LoginButton />
        </div>
      </header>

      <main className="mx-auto flex max-w-[640px] flex-col gap-10 px-6 py-12">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-[0.1em] text-[#8F8F8F]">{ready ? `Step ${step} of 3` : " "}</span>
          <h1 className="m-0 text-[32px] font-normal leading-tight tracking-[-0.02em]">Get started</h1>
          <p className="m-0 text-[15px] text-[#6E6E73]">Log in, add test HBAR, and subscribe once. It all runs on Hedera testnet, so nothing costs real money.</p>
        </div>

        <ol className="m-0 flex list-none flex-col p-0">
          <Step
            n={1}
            state={stateOf(1)}
            title={authenticated ? "Signed in" : "Log in"}
            hint={authenticated ? undefined : "Email login creates a wallet for you, with no seed phrase. You can also connect your own wallet."}
          >
            {!ready ? (
              <div className="h-9 w-48 animate-pulse rounded-full bg-[#F4F4F4]" />
            ) : authenticated ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[#F7F7F5] px-3.5 py-2 font-mono text-[13px]" title={address}>
                  {address ? shortAddress(address) : "creating your wallet…"}
                </span>
                {address && (
                  <button onClick={copy} className={secondary}>
                    {copied ? "Copied" : "Copy address"}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <LoginButton />
                <button onClick={() => connectWallet()} className={secondary}>
                  Connect a wallet
                </button>
              </div>
            )}
          </Step>

          <Step
            n={2}
            state={stateOf(2)}
            title={subscribed ? "Subscribed" : "Subscribe"}
            hint={`${PLAN_PRICE_HBAR} HBAR buys ${PLAN_CREDITS.toLocaleString("en-US")} credits, paid once. Skip this if a team pays for you.`}
          >
            {authenticated &&
              (subscribed ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] bg-[#E7F5EE] px-4 py-3 text-[#0B7A5D]">
                  <span className="text-[15px]">{Number(account!.credits).toLocaleString("en-US")} credits ready</span>
                  <span className="font-mono text-xs">{hbar!.toFixed(2)} HBAR left in your wallet</span>
                </div>
              ) : !address ? (
                <div className="h-28 animate-pulse rounded-[14px] bg-[#F4F4F4]" />
              ) : (
                <>
                  <div className="flex flex-col gap-3 rounded-[14px] border border-[#E5E5E0] p-4">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <div className="flex flex-col">
                        <span className="text-xs text-[#6E6E73]">Wallet balance</span>
                        {hbar !== null ? (
                          <span className="text-[26px] tabular-nums tracking-[-0.01em]">{hbar.toFixed(2)} HBAR</span>
                        ) : readFailed ? (
                          <span className="text-[15px] text-[#B3261E]">Could not read the balance. Refresh to try again.</span>
                        ) : (
                          <span className="mt-1 h-7 w-28 animate-pulse rounded-md bg-[#F4F4F4]" />
                        )}
                      </div>
                      {hbar !== null && (
                        <span className={`rounded-full px-2.5 py-1 text-xs ${funded ? "bg-[#E7F5EE] text-[#0B7A5D]" : "bg-[#FDF3E2] text-[#8A5300]"}`}>
                          {funded ? "Ready to subscribe" : `${(NEEDED_HBAR - hbar).toFixed(2)} HBAR to go`}
                        </span>
                      )}
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-[#F0F0EC]">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${funded ? "bg-[#0B7A5D]" : "bg-[#0D0D0D]"}`}
                        style={{ width: `${hbar === null ? 0 : Math.min(100, (hbar / NEEDED_HBAR) * 100)}%` }}
                      />
                    </div>
                    {!funded && (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          <button onClick={copy} className={secondary}>
                            {copied ? "Copied" : "Copy address"}
                          </button>
                          <a href="https://faucet.hedera.com" target="_blank" rel="noreferrer" className={secondary}>
                            Open faucet ↗
                          </a>
                          {drip === "idle" || drip === "sending" ? (
                            <button onClick={dripFunds} disabled={drip === "sending"} className={secondary}>
                              {drip === "sending" ? "Sending…" : "Get 0.5 HBAR"}
                            </button>
                          ) : null}
                        </div>
                        <p className="m-0 text-xs text-[#8F8F8F]">Paste your address into the faucet. The balance updates here on its own.</p>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    <button
                      onClick={subscribe}
                      disabled={busy || !funded}
                      className="flex h-11 items-center rounded-full bg-[#0D0D0D] px-6 text-sm text-white transition-colors hover:bg-zinc-800 disabled:bg-[#D4D4CF]"
                    >
                      {busy ? "Confirm in your wallet…" : `Subscribe for ${PLAN_PRICE_HBAR} HBAR`}
                    </button>
                    <button onClick={() => setTick((t) => t + 1)} className="text-sm text-[#6E6E73] underline-offset-4 hover:text-[#0D0D0D] hover:underline">
                      Refresh
                    </button>
                  </div>
                </>
              ))}
            {msg && <p className={`m-0 rounded-lg px-3 py-2 text-sm ${tone[msg.tone]}`}>{msg.text}</p>}
            <p className="m-0 text-xs text-[#8F8F8F]">
              Paid to the subscription vault{" "}
              <a href={contractUrl(VAULT)} target="_blank" rel="noreferrer" className="font-mono underline-offset-2 hover:text-[#0D0D0D] hover:underline">
                {shortAddress(VAULT)}
              </a>{" "}
              on Hedera testnet.
            </p>
          </Step>

          <Step n={3} state={stateOf(3)} title="Use it" hint="Chat with open models, or earn by serving one." last>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Link
                href="/chat"
                className={`group flex flex-col gap-1 rounded-[14px] border p-4 transition-colors ${subscribed ? "border-[#0D0D0D] bg-[#0D0D0D] text-white hover:bg-zinc-800" : "border-[#E5E5E0] hover:border-[#0D0D0D]"}`}
              >
                <span className="flex items-center justify-between text-[15px] font-medium">
                  Chat now <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
                </span>
                <span className={`text-sm ${subscribed ? "text-white/70" : "text-[#6E6E73]"}`}>{subscribed ? "Your credits pay per request." : "Use your credits, or bill a team you belong to."}</span>
              </Link>
              <Link href="/host" className="group flex flex-col gap-1 rounded-[14px] border border-[#E5E5E0] p-4 transition-colors hover:border-[#0D0D0D]">
                <span className="flex items-center justify-between text-[15px] font-medium">
                  Serve a model <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
                </span>
                <span className="text-sm text-[#6E6E73]">Run a host and earn per request.</span>
              </Link>
            </div>
          </Step>
        </ol>
      </main>
    </div>
  );
}
