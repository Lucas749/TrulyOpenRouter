#!/usr/bin/env node
// Agent helper: send one chat request with an agent key, and when a limit needs a
// human approval, wait for the decision and retry the same request exactly once.
// The helper only polls; approvals happen in the app (team owner) or on the Ledger.
//
//   TOR_AGENT_KEY=tor_sk_agt_... node scripts/agent-request.mjs "Summarize this repo"
// Env: TOR_BASE (default https://trulyopenrouter.vercel.app/api/gw), MODEL, MAX_TOKENS,
//      IDEMPOTENCY_KEY (default: a new random key per task),
//      TOR_AGENT_KEY_FILE (default ~/.config/trulyopenrouter/agent-key, used when TOR_AGENT_KEY is unset).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = (process.env.TOR_BASE ?? "https://trulyopenrouter.vercel.app/api/gw").replace(/\/+$/, "");
const keyFile = process.env.TOR_AGENT_KEY_FILE ?? join(homedir(), ".config", "trulyopenrouter", "agent-key");
// A key file lets an agent harness run this without the key in its environment or transcript.
const key = process.env.TOR_AGENT_KEY ?? (() => { try { return readFileSync(keyFile, "utf8").trim(); } catch { return undefined; } })();
const prompt = process.argv.slice(2).join(" ") || "hello";
if (!key?.startsWith("tor_sk_agt_")) {
  console.error(`Set TOR_AGENT_KEY or save an agent key (tor_sk_agt_...) to ${keyFile}.`);
  process.exit(2);
}

const idempotencyKey = process.env.IDEMPOTENCY_KEY ?? `task-${randomUUID()}`;
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey };
const body = JSON.stringify({ model: process.env.MODEL ?? "qwen2.5:0.5b", messages: [{ role: "user", content: prompt }], max_tokens: Number(process.env.MAX_TOKENS ?? 256) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send() {
  const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers, body });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let { status, data } = await send();
if (status === 403 && data?.error?.type === "approval_required") {
  const approval = data.error;
  console.error(`${approval.message}\nApproval needed: ${approval.approval_url}\nExtra credits requested: ${approval.additional_credits_requested} (${approval.constraint})`);
  let state = approval.approval_state;
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
