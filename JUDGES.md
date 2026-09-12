## For Judges & Sponsors

### Hedera — x402 payments, HTS settlement, HCS audit

**Deployed on testnet (chain 296)**

| | Address |
|---|---|
| `SubscriptionVault` | [`0xd75c46c0…f576`](https://hashscan.io/testnet/contract/0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576) |
| `HostRegistry` | [`0x5f83c194…dc56`](https://hashscan.io/testnet/contract/0x5f83c19413fc15181e2e79512947e374c7b8dc56) |
| Test USDC (HTS) | [`0.0.429274`](https://hashscan.io/testnet/token/0.0.429274) |
| HCS audit topic | [`0.0.10379640`](https://hashscan.io/testnet/topic/0.0.10379640) |

**x402 payments that settled.** Each is 1000 units of test USDC leaving the gateway's payer
`0.0.10375331` and arriving at the host that served the request, settled through the
**Blocky402** facilitator.

| Receipt | HCS seq | USDC to host |
|---|---|---|
| `e6b3cd77…` | 32 | [`0.0.7162784-1789249458-628934885`](https://hashscan.io/testnet/transaction/0.0.7162784-1789249458-628934885) |
| `1d069663…` | 31 | [`0.0.7162784-1789249332-770757376`](https://hashscan.io/testnet/transaction/0.0.7162784-1789249332-770757376) |
| `438b2448…` | 30 | [`0.0.7162784-1789249021-108815497`](https://hashscan.io/testnet/transaction/0.0.7162784-1789249021-108815497) |
| `1389caf2…` | 29 | [`0.0.7162784-1789248230-444847740`](https://hashscan.io/testnet/transaction/0.0.7162784-1789248230-444847740) |

The first end-to-end loop: [subscribe](https://hashscan.io/testnet/transaction/0xbc6a0fdf538d3bdac8adb9230d9a167c972f88745a535f5f5c2ad95cb0b3da85)
→ route → receipt → vault debit → [host withdraw](https://hashscan.io/testnet/transaction/0x02bdc9f322bd7da968e3b73225729c3d7c60629af2d8ca4b5e79671c5951d8fc).

**Code to read**

- `gateway/src/x402.ts` — which facilitator settles the payment. Fifteen lines, and the only
  place that choice is made: testnet settles through **Blocky402**.
- `gateway/src/payer.ts` — the paid retry. `paymentRequirementProblem()` refuses a host's
  402 terms unless scheme, network, asset, amount, fee payer and payee all fit hard bounds;
  `onBeforePaymentCreation` then checks the payee account's **EVM alias matches the registered
  host** before anything is signed, and claims a daily treasury ceiling.
- `host-runner/guard/src/index.ts` — the host side: an x402 paywall in front of Ollama that
  quotes `$0.001` on `hedera:testnet` and only proxies once payment verifies.
- `contracts/src/SubscriptionVault.sol` — `subscribe()` buys credits; `debit()` is gateway-only
  and splits 90% to `hostEarnings` / 10% to `accruedFees`; `withdraw()` pays hosts; `refund()`
  returns unspent credits at a fixed rate.
- `contracts/src/HostRegistry.sol` — permissionless `register()` with a 4 HBAR stake,
  `heartbeat()`, and `deregister()` → `release()` behind a 24h timelock.
- `gateway/src/receipts.ts` · `gateway/src/hcs.ts` — one receipt ties both money legs together;
  its id is the HCS topic message.

### Privy — the AI compute wallet

**How it works.** Privy used as login so it's perfect for non crypto natives. No seed phrase, no
extension.

Privy is used to build our **AI compute wallet** for the new currency 'compute'. 
A team gets a Privy organization wallet, and every control a team actually wants sits
on top of it — per-seat spending caps, a daily ceiling for the whole org, which models and
regions are allowed, pinned hosts, verified-hosts-only, rate limits, and cutting off a
member's access. Think Claude Team but on web3. Those rules are checked before a payment clears: a request that breaks 
one is refused with `org_policy` and no host is ever contacted.

Every treasury action runs as a Privy **intent**, and approving one means signing the exact
bytes of that action:

1. `approveTreasuryIntent` returns **428 `approval_signature_required`** with the precise
   payload to sign (`treasury.ts:722`).
2. The approver's browser signs those bytes and they go to `/intents/<id>/authorize`
   (`treasury.ts:731`). Privy rejects anything that isn't the reviewed terms.
3. Only then does the **broker** co-sign with `generateAuthorizationSignature`
   (`treasury.ts:747`). With both signatures in hand, Privy releases the transaction.

**Code to read**

- `gateway/src/treasury.ts` — the whole treasury. `provisionTeamWallet` creates the wallet with
  `authorization_threshold: 2` and a deny-by-default policy; `verifyTeamWallet` refuses to
  activate a wallet whose owner, policy, threshold or signer set doesn't match what we expect;
  `approveTreasuryIntent` is the 428 → user-signs → broker-co-signs flow above.
- `web/lib/intents.ts` — `authorizePayload()`: the exact bytes an authorize signature covers.
- `web/lib/quorum-keys.ts` — where the server-held quorum key lives.
- `web/lib/session.ts` · `web/lib/privy-server.ts` — server-side verification that a login owns
  the wallet it claims, and that it's an active member of the team it bills.
- `web/app/team/treasury.tsx` — deposit, buy credits, pay out, limits, and the amber
  "waiting for your approval" card that drives the signature.
- `gateway/src/teams.ts` — team state, allowances, and the Ledger payout threshold.
- `gateway/src/orgrules.ts` · `gateway/src/index.ts:439` — the rules a team sets, and the one
  place every request is measured against them. Models, regions, pinned hosts, verified-only,
  rate limit and daily ceiling are all checked before a host is chosen; a breach raises
  `OrgPolicyDenied` and the request stops there.
- `web/app/team/rules.tsx` · `web/lib/rule-sync.ts` — the rules UI, and the sync that pushes
  them to the gateway so enforcement never depends on the browser.
- `web/app/team/members.tsx` — seats, roles, per-member caps, invites and removal.
- `web/app/agents/agents-panel.tsx` — the same idea one level down: an agent key with its own
  ceiling, its own allowed models and regions, and a switch for whether it may ask for more.


### Ledger — key custody and human approval

Ledger for high value security of agents. Compute is the new money and tokens are expensive for
frontier models. 

**1. Key Ring (custody never share your API key).** `tor-host ledger init` roots a **trustchain** in the
device seal — one press, once. After that this machine holds a *membership*, and membership is
what encrypts and decrypts. An agent key lives on disk only as ciphertext and is opened into
memory for a single task. A server with no USB port can therefore hold a key it can never leak,
and access is **revocable**: delete one keychain entry and it can open nothing, every file intact.

**The problem.** To run an agent on a box you don't sit at, you normally copy your API key onto
it. Anyone with the disk, a backup, a log line or root then has your key, and you find out from
the bill. Here the key never exists in readable form on that machine.

**How we built it.** `tor-agent seal` pipes the key in on stdin — never an argument, so it never
reaches shell history or `ps` — into `wallet-cli ring encrypt`, and only ciphertext lands on disk
at `0600`. `tor-agent enroll --docker <name>` then copies this Mac's membership into the
container's own keychain, again over stdin. Ledger's CLI has no primitive for enrolling a machine
with no device attached; that piece is ours.

**What we showed.** A container with `/dev/bus/usb` empty — no Ledger can ever be plugged into it
— locked out before enrolment, enrolled from the Mac, then opening its sealed key with no device
attached. At the end the membership is deleted and the same container can open nothing, every
file still in place.

**2. Approvals (a tap every time).** An over-limit spend is an EIP-191 `personal_sign` on
`44'/60'/0'/0/0`. The agent cannot approve itself — the gateway accepts only a signature from
the enrolled device.

**The problem.** An agent with a budget will spend it. The usual answer is to trust it and read
the invoice afterwards. Here the ceiling is enforced before any host is contacted, and the
agent's only move when it hits one is to ask.

**How we built it.** Over its limit, the gateway refuses with `403 approval_required` and creates
an approval whose message binds the exact terms — agent, payer, model, request hash, credits, the
limit it hit, a nonce and an expiry — so a signature cannot be replayed against different terms.
The device signs that message as an EIP-191 `personal_sign`. `claimGrant` then burns it: one
grant, one request, five minutes. The same decision can be made in a browser over WebHID.

**What we showed.** A remote agent stopped by its own daily limit, the terms read on the device,
one press, and the same request finishing on its own — nothing raised, no new budget.

| Receipt | HCS seq | Signed on |
|---|---|---|
| `4e143783…` | [18](https://hashscan.io/testnet/topic/0.0.10379640) | a physical Ledger |
| `ab0f7b13…` | [19](https://hashscan.io/testnet/topic/0.0.10379640) | a physical Ledger, from the container with no USB port |

**Code to read**

- `agent-cli/src/ring.mjs` — seal and unseal. The key crosses on stdin only, never an argument;
  the password is read from the OS keychain and never printed.
- `agent-cli/src/enroll.mjs` — gives a container its own Key Ring membership over stdin. Ledger's
  CLI has no primitive for this; it is the piece we built.
- `gateway/src/ring.ts` — in ring mode the gateway loads its own broker secrets from the Key Ring,
  with no environment fallback.
- `gateway/src/approvals.ts` — `approvalMessage()` binds origin, network, approval id, agent,
  payer, model, request hash, credits, limits, TTL, revisions, nonce and expiry, so a signature
  cannot be replayed against different terms. `claimGrant` makes it single-use.
- `agent-cli/src/ledger-sign.mjs` — the device signature for an approval.
- `web/lib/ledger-device.ts` — WebHID via the Device Management Kit, for approving in a browser.
- `gateway/src/taps.ts` · `gateway/src/tap-exec.ts` — high-risk server actions (stake release)
  never execute without a recorded device tap.
- `docs/DX-FEEDBACK-ledger.md` — feedback and issues

Run it: `node agent-cli/demo.mjs` walks the whole thing — sealed key, a container with no USB
port, the agent stopped by its own limit, the press, the answer, then the host cut off.