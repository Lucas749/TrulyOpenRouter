<div align="center">

<img src="web/app/icon.svg" width="72" alt="TrulyOpenRouter" />

# TrulyOpenRouter

**One subscription. Every open model. Hosts get paid per call.**

An open router for AI inference, where an agent that wants to spend more
has to ask a human holding a Ledger.

[![Live site](https://img.shields.io/badge/trulyopenrouter.vercel.app-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://trulyopenrouter.vercel.app)
[![Source](https://img.shields.io/badge/Lucas749%2FTrulyOpenRouter-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Lucas749/TrulyOpenRouter)

</div>

Users pay a flat HBAR subscription. Each request pays the serving host 0.001 test USDC
over x402 and meters the user's credits. Hosts register permissionlessly, serve through
a payment-gated guard, and withdraw anytime. Every settled call leaves a receipt mirrored
to an HCS audit topic.

## How money moves

1. **Subscribe** — HBAR into `SubscriptionVault` → credits (10 HBAR → 10,000).
2. **Chat** — the gateway routes to a host; $0.001 testnet USDC goes to that host's
   wallet via x402 (Blocky402 facilitator); vault credits are metered down. One receipt
   ties both legs together.
3. **Stake** — hosts lock HBAR in `HostRegistry` to serve. Released via `release()` after
   deregister + timelock, gated by a Ledger tap.
4. **Teams** — a Privy team wallet, owned by a 2-of-2 quorum, buys credits through approved
   intents. Members and team agents spend within allowances; linked hosts collect into it.
5. **Agents** — `tor_sk_agt_` keys with hard limits. Over the limit the request stops and
   waits for a human instead of spending more.

Contracts: Registry `0x5f83c19413fc15181e2e79512947e374c7b8dc56`
(legacy `0xa45461bdefef422a81b22f36ebfd0995c7642dc3`), Vault
`0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576`, USDC `0.0.429274`, HCS topic `0.0.10379640`.

The gateway spends separately funded test USDC from account `0.0.10375331`. HBAR
subscriptions do not convert into USDC. Testnet tokens have no financial value.

## The agent story

An agent gets its own key, its own ceiling, and no way to raise either.

- **The key is sealed in a Ledger Key Ring.** `wallet-cli ring encrypt` puts ciphertext on
  disk; `tor-agent` decrypts it into memory for one task. There is no plaintext key in a
  file, an environment variable, or a transcript.
- **A host with no USB port can still hold it.** `tor-agent enroll --docker <name>` reads
  this Mac's Key Ring membership and provisions the container's own keychain over stdin, so
  a device-less box can open Key Ring secrets headlessly. Ledger's CLI has no primitive for
  this; removing that one keychain entry cuts the host off with every file left in place.
- **Limits are enforced before any host is paid.** Per day, per month, per lifetime, per
  request, plus models, regions, verified-hosts-only, rate and concurrency.
- **Over the limit it asks.** The gateway refuses the request, creates an approval bound to
  those exact terms, and returns `403 approval_required`. The agent cannot approve itself:
  the server accepts only a signature from the enrolled Ledger, or a team owner's wallet.
- **One press buys one request** — not a new budget. Single-use, five-minute grant.

```sh
tor-agent seal                      # seal an agent key into the Key Ring
tor-agent run "<task>"              # one task; stops for a human when over its limit
tor-agent approve [<id>]            # sign what's waiting, from the machine with the Ledger
tor-agent enroll --docker <name>    # give a host with no USB port its own membership
tor-agent status                    # limits, usage, and anything waiting
node agent-cli/demo.mjs             # the guided 10-step demo (--start N to resume, --wait to step)
```

## Where it runs

```
browser ──▶ Vercel (Next.js UI + its own Postgres for team state)
                │  /api/gw/*
                ▼
            gateway :4121  ──▶ RDS Postgres (agents, approvals, receipts, team mirror)
                │                      │
                │ routes + pays        └──▶ HCS topic 0.0.10379640 (receipt ids)
                ▼
            guard :4122 ──▶ Ollama        ← one VPS runs the gateway and this host
```

A request goes browser → Vercel → the gateway. The gateway checks the caller's limits
**before** contacting anyone, picks a host, calls its guard, gets an HTTP 402, signs a
test-USDC transfer on Hedera, and retries. The host serves the completion, the user's vault
credits are metered down, and one receipt records both legs.

Hosts are independent: anyone can run the guard on their own machine and register. The VPS
happens to run one so the network is never empty.

## Run it

```sh
# 1. host stack (needs Docker)
docker compose -f host-runner/docker-compose.yml up -d ollama guard  # :4122

# 2. gateway (keys come from the Ledger Key Ring, not env files)
cd gateway && SECRETS_BACKEND=ring PORT=4121 \
  HOSTS_JSON='[{"endpoint":"http://127.0.0.1:4122","modelId":"qwen2.5:0.5b"}]' \
  npx tsx src/index.ts                                              # :4121

# 3. web
npm run dev --prefix web                                            # :3002
```

Then open `/onboarding`: login → subscribe → chat. Operator guide in
`host-runner/README.md`, hosting guide in `DEPLOY.md`.

Becoming a host is one command: `curl -fsSL https://trulyopenrouter.vercel.app/install.sh | bash`

## Operator configuration

| Var | What | Default |
|---|---|---|
| `SECRETS_BACKEND=ring` | Decrypt `gateway/secrets/*.enc` at boot (needs `WALLET_PASS`) | env vars |
| `TAP_HEDERA_ACCOUNT` | Recorded Ledger Hedera account tap approvals must come from | unset = taps 501 |
| `TAPS_DIR` / `MIRROR_URL` | Tap store dir / mirror node for approval checks | `./.data`, testnet mirror |
| `GATEWAY_ADMIN_TOKEN` | Authorizes `/api/admin/*` (web is the only caller) | unset = 501 |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Server verification of browser sessions and linked wallets | missing = browser inference unavailable |
| `RPC_URL` / `VAULT_ADDRESS` / `OPERATOR_KEY` | Subscription balance reads and confirmed debits | missing = inference unavailable |
| `BUDGET_MASTER` | Derives a separate subscription payer for each API key | missing = keyed inference unavailable |
| `X402_PAYER_ID` / `X402_PAYER_KEY` | Separately funded test USDC payer for hosts | required for paid host requests |
| `HEDERA_SERVICE_ACCOUNT_ID` | Optional additional x402 charge at the gateway entrance | unset = subscription gate only |
| `HOSTS_JSON` | Static hosts, no chain (`[{endpoint,modelId,…}]`) | onchain registry |
| `GATEWAY_CREDIT_UNITS` | Units per credit (money rule: 1e5) | `100000` |

## Payment flow (for the Hedera judges)

We settle x402 **through the Blocky402 facilitator** (`https://api.testnet.blocky402.com`)
— deliberately, not the PoC default `x402.org`, because the prize requires facilitator
settlement on Hedera. Metered, not flat: base + per-1k-tokens → credits at a 1e5 divisor.
The settlement asset is testnet USDC (HTS token in path). Every settled receipt is mirrored
to HCS; the receipt id *is* the topic message.

x402 runs **gateway → host**. The caller does not pay x402 at the front door. Each request
produces two separate legs: `x402Transaction` (USDC to the host) and `debitTx` (vault
credits). Before signing, the gateway validates scheme, network, asset, amount, fee payer
and payee against hard bounds, checks the payee's EVM alias matches the registered host,
and claims a daily treasury ceiling.

One quirk that cost us an afternoon: the hashio relay delivers contract `msg.value` in
**tinybars, not wei**. All vault amounts are in delivered units.

## Repo map

- `contracts/` — `HostRegistry.sol`, `SubscriptionVault.sol` (Foundry, 22 tests)
- `gateway/` — routing, x402 gate, budgets, receipts, HCS, verification, approvals, treasury
- `host-runner/guard/` — payment-gated Ollama proxy (the host sidecar)
- `host-runner/cli/` — `tor-host`: login, run, status, leave, verify, ledger, withdraw
- `agent-cli/` — `tor-agent`: seal, run, approve, enroll, status + the guided demo
- `web/` — chat, network explorer, hosting, agents, team treasury, `/security` tap queue
- `gateway/secrets/*.enc` — ciphertext only. Keys live in a Ledger trustchain.
- `docs/DX-FEEDBACK-ledger.md` — what Ledger's tooling got right and wrong

Tests: 174 gateway · 78 web · 22 contracts · plus guard and CLI suites.

## Sponsors

- **Hedera** — a live x402-gated service on testnet settled through Blocky402, consumed end
  to end by an agent that pays per request. HTS token in the settlement path, HCS audit
  topic, budget-capped agent consumers.
- **Privy** — email login → embedded wallet. Each team gets a Privy organization wallet
  owned by a two-signature quorum (the team's financial approver plus the gateway broker
  key) with a deny-by-default policy: exact-price vault purchases, refunds, and capped
  payouts to approved recipients. Treasury actions run as Privy **intents**; the gateway
  checks the signed bytes against the reviewed terms before broadcasting. It refuses to
  activate a team wallet whose quorum, threshold, policy or signer set doesn't match.
- **Ledger** — the agent's key is sealed in the Ledger Key Ring (`wallet-cli ring`) and
  decrypted in memory per task. Agents enrol a Ledger through the Device Management Kit
  (WebHID in the browser, node-hid in the terminal). Over-limit requests pause until that
  device signs the exact approval and then resume **once**; widening a protected agent's
  policy needs the same device, and treasury payouts above a threshold do too. In ring mode
  the gateway loads its broker secrets from `wallet-cli ring` with no environment fallback.

## For judges: what to read, and where it ran

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
**Blocky402** facilitator — deliberately not the `x402.org` reference default.

| Receipt | HCS seq | USDC to host |
|---|---|---|
| `e6b3cd77…` | 32 | [`0.0.7162784-1789249458-628934885`](https://hashscan.io/testnet/transaction/0.0.7162784-1789249458-628934885) |
| `1d069663…` | 31 | [`0.0.7162784-1789249332-770757376`](https://hashscan.io/testnet/transaction/0.0.7162784-1789249332-770757376) |
| `438b2448…` | 30 | [`0.0.7162784-1789249021-108815497`](https://hashscan.io/testnet/transaction/0.0.7162784-1789249021-108815497) |
| `1389caf2…` | 29 | [`0.0.7162784-1789248230-444847740`](https://hashscan.io/testnet/transaction/0.0.7162784-1789248230-444847740) |

The first end-to-end loop: [subscribe](https://hashscan.io/testnet/transaction/0xbc6a0fdf538d3bdac8adb9230d9a167c972f88745a535f5f5c2ad95cb0b3da85)
→ route → receipt → vault debit → [host withdraw](https://hashscan.io/testnet/transaction/0x02bdc9f322bd7da968e3b73225729c3d7c60629af2d8ca4b5e79671c5951d8fc).

**Code to read**

- `gateway/src/x402.ts` — facilitator selection. 15 lines, and the whole Blocky402 decision.
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

**Two money legs, deliberately separate.** `x402Transaction` pays the host in USDC;
`debitTx` meters the caller's credits in the vault. Deposited HBAR never becomes USDC — the
gateway funds the USDC leg from its own account.

### Privy — team treasury and approval signing

**How it works.** A team gets a Privy **organization wallet** owned by a **2-of-2 key quorum**:
the team's financial approver (a Privy user) plus the platform's broker P-256 key. The broker
cannot move funds alone. Treasury actions run as Privy **intents**, and approval is a real
signature over exact bytes, not a database flag:

1. `approveTreasuryIntent` returns **428 `approval_signature_required`** with the precise
   payload to sign (`treasury.ts:722`).
2. The approver's browser signs those bytes and they go to `/intents/<id>/authorize`
   (`treasury.ts:731`). Privy rejects anything that isn't the reviewed terms.
3. Only then does the **broker** co-sign with `generateAuthorizationSignature`
   (`treasury.ts:747`), satisfying the quorum and releasing the transaction.

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

Email login → embedded wallet, so a user never handles a seed phrase; `payoutNeedsLedger()`
escalates large payouts to hardware (below).

### Ledger — key custody and human approval

Two distinct mechanisms, often confused:

**1. Key Ring (custody, no tap per use).** `tor-host ledger init` roots a **trustchain** in the
device seal — one press, once. After that this machine holds a *membership*, and membership is
what encrypts and decrypts. An agent key lives on disk only as ciphertext and is opened into
memory for a single task. A server with no USB port can therefore hold a key it can never leak,
and access is **revocable**: delete one keychain entry and it can open nothing, every file intact.

**2. Approvals (a tap every time).** An over-limit spend is an EIP-191 `personal_sign` on
`44'/60'/0'/0/0`. The agent cannot approve itself — the gateway accepts only a signature from
the enrolled device. One press buys **one request**, not a new budget: single-use, five-minute grant.

**Code to read**

- `agent-cli/src/ring.mjs` — seal and unseal. The key crosses on **stdin only**, never an
  argument; the password is read from the OS keychain and never printed.
- `agent-cli/src/enroll.mjs` — gives a container its own Key Ring membership over stdin. Ledger's
  CLI has no primitive for this; it is the piece we built.
- `agent-cli/src/ledger-sign.mjs` — the device signature for an approval.
- `gateway/src/approvals.ts` — `approvalMessage()` binds origin, network, approval id, agent,
  payer, model, request hash, credits, limits, TTL, revisions, nonce and expiry, so a signature
  cannot be replayed against different terms. `claimGrant` makes it single-use.
- `web/lib/ledger-device.ts` — WebHID via the Device Management Kit, for approving in a browser.
- `gateway/src/taps.ts` · `gateway/src/tap-exec.ts` — high-risk server actions (stake release)
  never execute without a recorded device tap.
- `gateway/src/ring.ts` — in ring mode the gateway loads its own broker secrets from the Key
  Ring with no environment fallback.
- `docs/DX-FEEDBACK-ledger.md` — what Ledger's tooling got right and wrong, written while using it.

Run it: `node agent-cli/demo.mjs` walks the whole thing — sealed key, a container with no USB
port, the agent stopped by its own limit, the press, the answer, then the host cut off.