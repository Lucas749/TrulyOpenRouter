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

**`wallet-cli` cannot sign a message.** An agent over its limit needs a human
to approve exact terms. `ring` encrypts and `send` broadcasts a transaction, but
there is no personal_sign. We first shipped the approval as a zero-value
`send` on Sepolia carrying the approval code as calldata: blind signing on the
device, test ETH on a second chain, and an RPC to verify it. We reverted that
and sign with the Device Management Kit over USB instead. A clear-signed
`wallet-cli sign-message` would have made the CLI alone enough.
