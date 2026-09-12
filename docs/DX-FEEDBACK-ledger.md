# Ledger DX feedback (wallet-cli v2.1.0, Nano S Plus @ 1.6.1, macOS)

We built our server secret custody and withdrawal approvals on `ring`.
It works fine but I had some issues. See below

## Issues

**`ring init` fails without a trustchain root, and nothing tells you that.**
Fresh device, genuine-check green, USB fine — init dies with "An unknown error
occurred talking to the Ledger." The actual problem: no Ledger Sync member
existed yet. The fix is installing + enabling Ledger Sync in Ledger Live
first, then init joins as slot 17.

**`--output json` doesn't help.** The failure comes back `{"code":"unknown"}`.
No cause, no trace id, nothing to paste into a report. A single hint —
"no trustchain member found, enable Ledger Sync first?" — would have ended it.
