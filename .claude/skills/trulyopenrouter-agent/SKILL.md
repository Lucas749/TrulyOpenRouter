---
name: trulyopenrouter-agent
description: Send a prompt to the TrulyOpenRouter compute network with the user's agent key, and handle requests over the agent's limits that wait for a human approval on the enrolled Ledger (or the team owner). Use when asked to run work on TrulyOpenRouter, spend agent credits, or exercise the Ledger human-in-the-loop flow.
---

# TrulyOpenRouter agent requests

An agent key carries hard limits set in the app at https://trulyopenrouter.vercel.app/agents. A request over a
daily, monthly, or lifetime limit is not sent. The gateway answers `403 approval_required` with an approval
link. The owner approves on the enrolled Ledger (personal agents) or in the app (team agents). The gateway
verifies that decision, and `gateway/scripts/agent-request.mjs` then sends the same request exactly once.

## One-time setup (the user, outside this chat)

1. At `/agents`: create the agent, click **Connect Ledger**, and fund its budget.
2. Copy the key shown once, then seal it in the Ledger Key Ring from their own terminal. Only ciphertext reaches disk:
   ```sh
   mkdir -p ~/.config/trulyopenrouter && pbpaste | WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring encrypt --key tor/agent > ~/.config/trulyopenrouter/agent-key.enc && chmod 600 ~/.config/trulyopenrouter/agent-key.enc && pbcopy < /dev/null
   ```
   This needs `wallet-cli ring init` done once on this machine (one Ledger tap). A plain key file at
   `~/.config/trulyopenrouter/agent-key` still works, but only when no sealed key exists.

Never ask for the key or the ring password in the chat. Never print, echo, cat, or log either.

## Send a request

From the repo root, run in the background, because an approval can take minutes. The password comes from the
keychain by substitution, so it never appears in the command, history, or transcript:

```sh
WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) MAX_TOKENS=256 node gateway/scripts/agent-request.mjs "<prompt>"
```

The first output line says where the key came from: `Agent key: decrypted from the Ledger Key Ring (tor/agent)`.

Read the task output after a few seconds and act on what it shows:

| Output | What to do |
| --- | --- |
| `Approval needed: <url>` | Give the user the link, the extra credits, and the limit named in the line above it. Say the approval happens on their Ledger (or in the app for a team agent). Wait for the task to finish. |
| Reply text, then `receipt <id>` | Done. Report the answer and the receipt id. |
| `The approval ended as denied` / `expired` / `cancelled` | Stop and tell the user. Retry only if they ask. |
| `Request failed (402)` | The budget is out of credits. The user funds it at `/agents`. |
| `Request failed (429)` with "Enroll a Ledger" | The agent has no Ledger. The user enrolls one at `/agents`. |
| `Request failed (403)` with `request_too_large` | Over the per-request cap. This never gets an approval. Shorten the task or lower `MAX_TOKENS`. |
| `Request failed (409)` or `(503)` | A payment or service problem. Report it once. Do not loop. |
| Exit 2, "No agent key" | Setup step 2 is missing. |
| Exit 2, "sealed in the Ledger Key Ring … Run with WALLET_PASS" | The command lacks the keychain substitution. Rerun it exactly as shown above. |
| Exit 2, "Key Ring decrypt failed" | This machine's ring cannot open the key (no `wallet-cli ring init`, or no network). Tell the user. Do not retry in a loop. |

## Rules

- One task, one run. The script already retries once after approval with the same `Idempotency-Key`.
- While an approval is pending, the user must not revoke the agent, edit its limits, rotate its key, or change its Ledger. Each of these cancels the approval or breaks the waiting run.
- `MODEL` picks the model (default `qwen2.5:0.5b`). Keep `MAX_TOKENS` small; the request maximum sets the credits reserved.
