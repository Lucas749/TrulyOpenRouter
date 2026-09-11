# TrulyOpenRouter

One subscription. Every open model. Hosts get paid per call.

Users pay a flat HBAR subscription. Each chat request pays the serving host 0.001
test USDC over x402 and meters the user's credits. Hosts register permissionlessly,
serve through a payment-gated guard, and withdraw anytime. Every settled call
leaves a receipt mirrored to an HCS audit topic.

Live on Hedera testnet (296). Built for ETHOnline 2026.

## How money moves

1. **Subscribe** — HBAR into `SubscriptionVault` → credits (10 HBAR → 10,000).
2. **Chat** — gateway routes to a host; $0.001 testnet USDC goes to the host
   wallet via x402; vault credits metered down. Receipt ties both together.
3. **Stake** — hosts lock HBAR in `HostRegistry` to serve. Released via
   `release()` after deregister + timelock, gated by a Ledger tap.
4. **Teams** — a Privy team wallet buys credits through approved intents;
   members and team agents spend them within allowances, and linked hosts
   collect earnings into it.
5. **Agents** — `tor_sk_agt_` keys with strict limits; an over-limit request
   waits for a team owner or Ledger approval instead of spending more.

Contracts: Registry `0x5f83c19413fc15181e2e79512947e374c7b8dc56`
(legacy `0xa45461bdefef422a81b22f36ebfd0995c7642dc3`), Vault
`0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576`, USDC `0.0.429274`,
HCS topic `0.0.10379640`.

The gateway spends separately funded test USDC from account `0.0.10375331`.
HBAR subscriptions do not convert into USDC. Testnet tokens have no financial
value.

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

Configure the subscription and identity variables below before serving requests.
Then open `/onboarding`: login → subscribe → chat. Full operator guide in
`SELF-HOST.md`.

## Operator configuration

| Var | What | Default |
|---|---|---|
| `SECRETS_BACKEND=ring` | Decrypt `gateway/secrets/*.enc` at boot (needs `WALLET_PASS` in env) | env vars |
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

We settled x402 **through the Blocky402 facilitator**
(`https://api.testnet.blocky402.com`) — deliberately, not the PoC default
`x402.org`, because the prize requires facilitator settlement on Hedera.
Metered (not flat): base + per-1k-tokens → credits at a 1e5 divisor.
Settlement asset is testnet USDC (HTS token in path). Every settled receipt is
mirrored to HCS; receipt id == topic message. Budget-capped agent consumers get
HKDF-derived Hedera accounts per API key and 429 past their cap.

One quirk that cost us an afternoon: the hashio relay delivers contract
`msg.value` in **tinybars, not wei**. All vault amounts are in delivered units.

## Repo map

- `contracts/` — `HostRegistry.sol`, `SubscriptionVault.sol` (Foundry, 22 tests)
- `gateway/` — routing, x402 gate, budgets, receipts, HCS, verification, tap queue
- `host-runner/guard/` — payment-gated Ollama proxy (the host sidecar)
- `host-runner/cli/` — `tor-host`: login, run, status, leave, verify, ledger
- `web/` — chat, network explorer, hosting, team spend, `/security` tap queue
- `gateway/secrets/*.enc` — ciphertext only. Keys live in a Ledger trustchain.

## Sponsors

- **Hedera**: x402 micropayments + HTS + HCS audit + budget agents (above).
- **Privy**: email login → embedded wallet. Each team gets a Privy
  organization wallet owned by a two-signature quorum (the team's financial
  approver and the gateway broker key) with a deny-by-default policy:
  exact-price vault purchases, refunds, and capped payouts to approved
  recipients. Treasury actions run as Privy intents, and the gateway checks the
  signed bytes against the reviewed terms before broadcasting to Hedera. Team
  owners approve spending increases for members and agents with their Privy
  wallet signature.
- **Ledger**: an agent's key is sealed in the Ledger Key Ring (`wallet-cli
  ring`) and decrypted in memory per task, so the agent never holds it in a
  file, environment, or transcript. Agents enroll a Ledger through the Device
  Management Kit. Over-limit requests pause until the enrolled Ledger signs the
  exact approval, in the browser (WebHID) or from the terminal over USB
  (`TOR_APPROVE=ledger`, `agent-demo/ledger-sign.mjs`), and resume once;
  widening or draining a protected agent needs the same device. In ring mode
  the gateway loads its broker secrets (budget master, x402 payer, Privy broker
  key) from `wallet-cli ring` with no environment fallback, and stake releases
  need a physical tap. DX notes in `docs/DX-FEEDBACK-ledger.md`.

## Honest staging

Stakes are not yet slashable (stub). No TEE hosts (roadmap). Verification is
behavioral probing, not attestation. Everything above is exactly what runs —
mock mode (`?mock=1`) is fixtures-only and bannered.

Team finance and agents run on testnet with live checks for Privy policy
enforcement, a browser-approved Privy treasury payout, agent budgets,
collections, and Key Ring decryption. A Ledger was enrolled to an agent live in
the browser; an over-limit approval on the device still needs a live run. The
deployed gateway reads environment secrets: `ring init` needs the device on the
machine it enrolls, and the gateway server has no USB port. Key Ring custody of
the agent key and of the gateway secrets runs on the operator's Mac.
