import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BASE, MAX_TOKENS, MODEL, fail, say } from "./config.mjs";
import { unsealAgentKey } from "./ring.mjs";
import { Spinner, banner, box, ok, warn } from "./ui.mjs";

// One task, one request. The agent key is opened from the Key Ring in memory, the gateway enforces the
// agent's limits, and anything over them waits for a human on the enrolled Ledger.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(key, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
}

/// @notice Sign one pending approval on the Ledger attached to this machine and hand the signature over.
/// The gateway checks it against the agent's enrolled device, so relaying it here is safe.
export async function approveOnLedger(key, approvalId) {
  const view = await api(key, `/v1/agent/approvals/${encodeURIComponent(approvalId)}`);
  const ledger = view.data?.ledger;
  if (!view.ok || !ledger) return say(warn("this approval has no Ledger route — use the approval page instead"));

  say(ok(`asking the Ledger enrolled to this agent (${ledger.address.slice(0, 10)}…) to sign the exact approval`));
  const script = fileURLToPath(new URL("./ledger-sign.mjs", import.meta.url));
  const signed = spawnSync(process.execPath, [script, ledger.address], { input: ledger.message, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  const signature = String(signed.stdout ?? "").trim();
  if (signed.status !== 0 || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return say(warn("no Ledger signature — the approval stays pending, and the approval link still works"));
  }

  const spin = new Spinner().start("checking the signature against the enrolled Ledger");
  const sent = await api(key, `/v1/agent/approvals/${encodeURIComponent(approvalId)}/ledger-signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature }),
  });
  spin.stop(sent.ok ? ok("approved on the enrolled Ledger") : warn(`the gateway refused the signature (${sent.status}): ${sent.data?.error?.message ?? "unknown error"}`));
}

/// @notice Sign whatever is waiting, from the machine that has the Ledger.
export async function approvePending() {
  say(banner());
  const key = await unsealAgentKey();
  const self = await api(key, "/v1/agent/self");
  if (!self.ok) return fail(`Could not read the agent (${self.status}): ${self.data?.error?.message ?? "unknown error"}`);
  const pending = (self.data.approvals ?? []).filter((a) => a.state === "pending");
  if (!pending.length) return say(ok("nothing is waiting for a human"));
  say(box("Waiting for you", [`approval: ${pending[0].id}`, `extra:    ${pending[0].additional_credits} credits`]));
  await approveOnLedger(key, pending[0].id);
}

export async function run(prompt, { approve = "wait" } = {}) {
  if (!prompt.trim()) fail('Usage: tor-agent run "<task>"');
  say(banner());
  const key = await unsealAgentKey();
  say(ok("agent key opened from the Ledger Key Ring, in memory only"));

  const idempotencyKey = process.env.IDEMPOTENCY_KEY ?? `task-${randomUUID()}`;
  const body = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: MAX_TOKENS });
  const send = () => api(key, "/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body });

  let spin = new Spinner().start(`asking the network for ${MODEL}`);
  let { status, data } = await send();

  if (status === 403 && data?.error?.type === "approval_required") {
    const approval = data.error;
    spin.stop(warn("over the agent's limit — nothing was sent and no host was paid"));
    say(box("Approval needed", [`limit:   ${approval.constraint}`, `extra:   ${approval.additional_credits_requested} credits`, `review:  ${approval.approval_url}`]));

    let state = approval.approval_state;
    if (approve === "ledger" && state === "pending") await approveOnLedger(key, approval.approval_id);

    spin = new Spinner().start("waiting for a human on the enrolled Ledger");
    while (state === "pending") {
      await sleep(Math.max(1, Number(approval.poll_after_seconds ?? 5)) * 1000);
      const polled = await api(key, `/v1/agent/approvals/${encodeURIComponent(approval.approval_id)}`);
      if (!polled.ok) {
        spin.stop(warn("approval check failed"));
        return fail(`${polled.status}: ${polled.data?.error?.message ?? "unknown error"}`);
      }
      state = polled.data.state;
    }
    if (state !== "approved") {
      spin.stop(warn(`the approval ended as ${state}`));
      return fail("The request was not sent.");
    }
    spin.stop(ok("approved — sending the same request once"));

    spin = new Spinner().start(`asking the network for ${MODEL}`);
    ({ status, data } = await send());
  }

  if (status !== 200) {
    spin.stop(warn(`request failed (${status})`));
    return fail(data?.error?.message ?? JSON.stringify(data).slice(0, 200));
  }
  spin.stop(ok("answered, and the host was paid for it"));

  process.stdout.write(`${data.choices?.[0]?.message?.content ?? ""}\n`);
  say(box("Done", [`model:   ${MODEL}`, `receipt: ${data.tor_receipt ?? "none"}`, `settled: ${data.tor_settled === true ? "yes" : "pending"}`]));
}
