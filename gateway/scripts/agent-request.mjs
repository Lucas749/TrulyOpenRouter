#!/usr/bin/env node
// Agent helper: send one chat request with an agent key, and when a limit needs a
// human approval, wait for the decision and retry the same request exactly once.
// The helper only polls; approvals happen in the app (team owner) or on the Ledger.
//
//   TOR_AGENT_KEY=tor_sk_agt_... node scripts/agent-request.mjs "Summarize this repo"
// Env: TOR_BASE (default https://trulyopenrouter.vercel.app/api/gw), MODEL, MAX_TOKENS,
//      IDEMPOTENCY_KEY (default: a new random key per task),
//      TOR_AGENT_KEY_ENC (default ~/.config/trulyopenrouter/agent-key.enc) + TOR_AGENT_KEY_RING (default tor/agent):
//        the key sealed in your Ledger Key Ring, decrypted into memory with `wallet-cli ring decrypt`
//        (needs WALLET_PASS, e.g. WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w)),
//      TOR_AGENT_KEY_FILE (default ~/.config/trulyopenrouter/agent-key): a plain key file, used only without a sealed key,
//      TOR_APPROVE=ledger-cli: approve an over-limit request from this terminal with Ledger's wallet CLI
//        (TOR_LEDGER_ACCOUNT picks the wallet-cli account label; TOR_LEDGER_AMOUNT defaults to "0 ETH").
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = (process.env.TOR_BASE ?? "https://trulyopenrouter.vercel.app/api/gw").replace(/\/+$/, "");
const configDir = join(homedir(), ".config", "trulyopenrouter");
const sealedFile = process.env.TOR_AGENT_KEY_ENC ?? join(configDir, "agent-key.enc");
const ringKey = process.env.TOR_AGENT_KEY_RING ?? "tor/agent";
const keyFile = process.env.TOR_AGENT_KEY_FILE ?? join(configDir, "agent-key");
const prompt = process.argv.slice(2).join(" ") || "hello";

// The agent key lives in the Ledger Key Ring: only ciphertext is on disk, and the plaintext exists
// in this process's memory for one task. A sealed key always wins; it never falls back to a file.
function agentKey() {
  if (process.env.TOR_AGENT_KEY) return process.env.TOR_AGENT_KEY;
  if (existsSync(sealedFile)) {
    if (!process.env.WALLET_PASS) {
      console.error(`The agent key is sealed in the Ledger Key Ring (${sealedFile}). Run with WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w).`);
      process.exit(2);
    }
    try {
      return execFileSync("wallet-cli", ["ring", "decrypt", "--key", ringKey], { input: readFileSync(sealedFile), stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").replace(/\n$/, "");
    } catch (e) {
      console.error(`Key Ring decrypt failed for ${ringKey}: ${String(e.stderr || e.message).slice(0, 200)}`);
      process.exit(2);
    }
  }
  try {
    return readFileSync(keyFile, "utf8").trim();
  } catch {
    return undefined;
  }
}

const key = agentKey();
if (!key?.startsWith("tor_sk_agt_")) {
  console.error(`No agent key. Seal one in the Ledger Key Ring at ${sealedFile} (see the trulyopenrouter-agent skill), or set TOR_AGENT_KEY.`);
  process.exit(2);
}
console.error(process.env.TOR_AGENT_KEY ? "Agent key: environment" : existsSync(sealedFile) ? `Agent key: decrypted from the Ledger Key Ring (${ringKey})` : `Agent key: plain file ${keyFile}`);

const idempotencyKey = process.env.IDEMPOTENCY_KEY ?? `task-${randomUUID()}`;
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey };
const body = JSON.stringify({ model: process.env.MODEL ?? "qwen2.5:0.5b", messages: [{ role: "user", content: prompt }], max_tokens: Number(process.env.MAX_TOKENS ?? 256) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cliJson = (text) => {
  try {
    return JSON.parse(String(text ?? "").slice(String(text ?? "").indexOf("{")));
  } catch {
    return null;
  }
};

/// The wallet-cli account holding `address` on a Sepolia network. Accounts that do not name Sepolia are
/// never picked, so an approval can never be sent on mainnet by accident.
function ledgerCliAccount(address) {
  const view = cliJson(spawnSync("wallet-cli", ["session", "view", "--output", "json"], { encoding: "utf8" }).stdout);
  const found = [];
  const walk = (value, key) => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, key));
    if (!value || typeof value !== "object") return;
    const own = String(value.address ?? value.freshAddress ?? "").toLowerCase();
    if (own === address.toLowerCase() && `${key} ${JSON.stringify(value)}`.toLowerCase().includes("sepolia")) found.push(value.label ?? value.account ?? key);
    for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(view, "");
  return found.find((label) => typeof label === "string" && label) ?? null;
}

function firstHash(value) {
  if (typeof value === "string") return /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
  if (!value || typeof value !== "object") return null;
  for (const v of Object.values(value)) {
    const hash = firstHash(v);
    if (hash) return hash;
  }
  return null;
}

/// Terminal approval: Ledger's wallet CLI sends the approval code from the enrolled Ledger to itself,
/// confirmed on the device, and the gateway verifies that transaction on chain before granting the spend.
/// Any step that cannot run leaves the approval pending for the approval page.
async function approveWithLedgerCli(approvalId) {
  const auth = { Authorization: `Bearer ${key}` };
  const res = await fetch(`${base}/v1/agent/approvals/${encodeURIComponent(approvalId)}`, { headers: auth });
  const tx = (await res.json().catch(() => ({}))).ledger_transaction;
  if (!res.ok || !tx) return console.error("This approval has no terminal Ledger route. Use the approval page instead.");
  const account = process.env.TOR_LEDGER_ACCOUNT ?? ledgerCliAccount(tx.from);
  if (!account) {
    return console.error(`No wallet-cli Sepolia account for ${tx.from}. With the Ledger connected, run once: wallet-cli account discover ${tx.network}`);
  }
  const args = ["send", account, "--to", tx.to, "--amount", process.env.TOR_LEDGER_AMOUNT ?? "0 ETH", "--data", tx.data, "--output", "json"];
  const dryRun = spawnSync("wallet-cli", [...args, "--dry-run"], { encoding: "utf8" });
  if (dryRun.status !== 0 || !`${account} ${dryRun.stdout}`.toLowerCase().includes("sepolia")) {
    return console.error(`wallet-cli could not prepare the Sepolia approval (${account}): ${String(dryRun.stdout || dryRun.stderr).slice(0, 300)}`);
  }
  console.error(`Confirm on your Ledger: a Sepolia transaction from ${tx.from} to itself with approval code ${tx.data.slice(0, 18)}…`);
  const sent = spawnSync("wallet-cli", [...args, "--device-timeout", "180000"], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  const hash = firstHash(cliJson(sent.stdout));
  if (sent.status !== 0 || !hash) return console.error(`wallet-cli send did not return a transaction: ${String(sent.stdout || sent.error?.message).slice(0, 300)}`);
  console.error(`Sent ${hash}. The gateway is verifying it on chain…`);
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/v1/agent/approvals/${encodeURIComponent(approvalId)}/ledger-transaction`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ transactionHash: hash }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return console.error("Verified on chain: approved by the enrolled Ledger.");
    if (!["transaction_pending", "chain_unavailable"].includes(d?.error?.type)) {
      return console.error(`The gateway refused the approval transaction (${r.status}): ${d?.error?.message ?? "unknown error"}`);
    }
    await sleep(5000);
  }
  console.error("The approval transaction was not confirmed within 5 minutes.");
}

async function send() {
  const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let { status, data } = await send();
if (status === 403 && data?.error?.type === "approval_required") {
  const approval = data.error;
  console.error(`${approval.message}\nApproval needed: ${approval.approval_url}\nExtra credits requested: ${approval.additional_credits_requested} (${approval.constraint})`);
  let state = approval.approval_state;
  if (process.env.TOR_APPROVE === "ledger-cli" && state === "pending") await approveWithLedgerCli(approval.approval_id);
  while (state === "pending") {
    await sleep(Math.max(1, Number(approval.poll_after_seconds ?? 5)) * 1000);
    const res = await fetch(`${base}/v1/agent/approvals/${encodeURIComponent(approval.approval_id)}`, { headers: { Authorization: `Bearer ${key}` } });
    const polled = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`Approval check failed (${res.status}): ${polled?.error?.message ?? "unknown error"}`);
      process.exit(1);
    }
    state = polled.state;
  }
  if (state !== "approved") {
    console.error(`The approval ended as ${state}. The request was not sent.`);
    process.exit(1);
  }
  console.error("Approved. Retrying the same request once.");
  ({ status, data } = await send());
}

if (status !== 200) {
  console.error(`Request failed (${status}): ${data?.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  process.exit(1);
}
console.log(data.choices?.[0]?.message?.content ?? "");
console.error(`receipt ${data.tor_receipt ?? "none"}`);
