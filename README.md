<img src="web/app/icon.svg" width="72" alt="TrulyOpenRouter" />

# TrulyOpenRouter

**[trulyopenrouter.vercel.app](https://trulyopenrouter.vercel.app)** · Hedera testnet (296) · built for ETHOnline 2026

One subscription. Every open model. Hosts get paid per call — and an agent that wants
to spend more has to ask a human holding a Ledger.

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
node agent-cli/demo.mjs             # the guided 10-step demo, pauses before each step
```

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

Then open `/onboarding`: login → subscribe → chat. Full operator guide in `SELF-HOST.md`,
hosting guide in `DEPLOY.md`.

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

## Honest staging

Stakes are not yet slashable (stub). No TEE hosts (roadmap). Verification is behavioural
probing, not attestation. Everything above is exactly what runs — mock mode (`?mock=1`) is
fixtures-only and bannered.

Live on testnet, with real runs recorded: Privy policy enforcement, a browser-approved
treasury payout, agent budgets, collections, Key Ring decryption with the device unplugged,
and **over-limit agent approvals signed on a physical Ledger — twice, once from a container
with no USB port** (receipts `4e143783…` and `ab0f7b13…`, HCS sequences 18 and 19).

Still unproven on a device: the treasury payout Ledger gate (code and tests only). The
deployed gateway reads environment secrets, because `ring init` needs the device on the
machine it enrols and the server has no USB port; Key Ring custody of the agent key and of
the gateway secrets runs on the operator's Mac.
