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

## Building an agent approval flow (DMK 1.9.0, signer-kit-ethereum 1.18.0, WebHID 1.2.4, node-hid 1.0.1)

**`wallet-cli` cannot sign a message.** An agent over its limit needs a human
to approve exact terms. `ring` encrypts and `send` broadcasts a transaction, but
there is no personal_sign. We first shipped the approval as a zero-value
`send` on Sepolia carrying the approval code as calldata: Blind signing on the
device, test ETH on a second chain, and an RPC to verify it. We reverted that
and sign with the Device Management Kit over USB instead. A clear-signed
`wallet-cli sign-message` would have made the CLI alone enough.

**`ring init` needs the device on the machine it enrolls.** "Bring the Key Ring
to hosts with no USB port" is the headline idea, but nothing lets an enrolled
laptop with the device add a headless member. Our gateway server could not
join, so production still reads its secrets from the environment.

**WebHID: a second discovery in one flow is refused.** Chrome opens the device
chooser only within a few seconds of a click. Our enrollment verified the
address, fetched a server challenge, then started a second discovery to sign;
the chooser never opened and the page showed `No Ledger selected: [object
Object]`. One session per click fixed it. The docs never say to reuse the
session across steps.

**DMK errors have no `message`.** `NoAccessibleDeviceError` and
`OpeningConnectionError` carry `_tag` and `originalError`, so `String(e)` is
`[object Object]` and users paste that into bug reports. We read
`originalError.message` ourselves now.

**A stalled connection gives no signal.** With the device on its dashboard,
enrollment looked frozen after the chooser. `confirm-open-app` only arrives once
a session exists. We added our own timeouts and step text.

**The ESM builds don't run in Node.** `lib/esm` of the management kit and the
Ethereum signer use directory imports that Node rejects
(`ERR_UNSUPPORTED_DIR_IMPORT`). Bundlers hide it; a Node script, which is where
an agent runs, hits it first. We load the CommonJS builds with `createRequire`.

**Hedera:** the CLI ships `hedera_testnet` entries, but discovery hung on our
device and `--memo` is Solana-only, so a Hedera-native approval transaction was
not an option either.

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
4. Add a clear-signed `wallet-cli sign-message`, so an agent can get a human's
   approval of exact text from the terminal without inventing a transaction.
5. Let an enrolled machine with the device add a headless `ring` member.
6. Give every DMK error a readable `message`.
7. Document one discovery per user gesture on WebHID, then reuse the session.
8. Ship ESM builds Node can import, or document `require` for Node scripts.

Total: first install to provisioned ring, ~40 min. Would be ~10 with fix (1).
