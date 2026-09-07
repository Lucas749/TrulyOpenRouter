# Ledger DX feedback (wallet-cli v2.1.0, Nano S Plus @ 1.6.1, macOS)

We built our server secret custody and withdrawal approvals on `ring`.
It works. Getting there took 40 minutes, 80% of it one maze.

## What bit us

**`ring init` fails without a trustchain root, and nothing tells you that.**
Fresh device, genuine-check green, USB fine — init dies with "An unknown error
occurred talking to the Ledger." The actual problem: no Ledger Sync member
existed yet. The fix is installing + enabling Ledger Sync in Ledger Live
first, then init joins as slot 17. The CLI says "open Ledger Sync app" — there
is no such device app, so that sentence sends you hunting through device menus
for something that doesn't exist.

**`--output json` doesn't help.** The failure comes back `{"code":"unknown"}`.
No cause, no trace id, nothing to paste into a report. A single hint —
"no trustchain member found, enable Ledger Sync first?" — would have ended it.

## What was genuinely good

- The keychain-injection pattern (`WALLET_PASS=$(security …)`) is the right
  call. Secrets never touch history, ps, or transcripts. Our agent harness
  only ever sees the substitution.
- Headless decrypt after unplugging the device is a real magic moment. That
  one take sold the whole prize story internally.
- `ring keys` showing names only is the correct default for agent-driven flows.

## Asks

1. Name the prerequisite in the init prompt ("needs an existing Ledger Sync
   trustchain — enable it in Ledger Live first").
2. Return the underlying cause in JSON errors, even if it's just a string.
3. Document that `wallet-cli` will never cover Hedera (or say that it might).
   We burned a session discovering the device holds HBAR but the CLI can't
   see it — `discover --network hedera` hangs instead of erroring.

Total: first install to provisioned ring, ~40 min. Would be ~10 with fix (1).
