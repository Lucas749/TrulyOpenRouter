# TrulyOpenRouter — Build Spec (locked 2026-09-04)

> Like OpenRouter, except open. Subscription on the outside, x402 on the inside.
> Anyone who can run a model can serve it; anyone who subscribes can use them all.

## 0. Locked decisions

- **Name:** TrulyOpenRouter (display) / `trulyopenrouter` (repo/org). Close consideration: NoCapRouter.
- **Sponsors (3 picks):** Hedera (AI & Agentic Payments $6k) + Privy (B2B $2.5k + flow $2.5k) + Ledger (AI Agents x Ledger $3.5k). Eligible total ~$22.5k.
- **Chain:** Hedera testnet first (x402 + contracts, EVM-compatible). No second chain unless Blocky402/faucet dies → fallback Arc testnet.
- **Models:** 8B-class only for demo (Llama-3.1-8B / Qwen2.5-7B-Instruct). No 70B.
- **Track:** from-scratch (no continuity pools).

## 1. How it works

**Users:** pay a flat fee (e.g. $10/mo USDC) → get credits → chat with any open model via one gateway. No per-prompt checkout, no rate-limit walls (fair-share quotas instead).

**Hosts:** run `docker compose up` with any OpenAI-compatible model endpoint → register onchain (stake, endpoint, model digest, price table) → earn ~90% of every routed call in USDC on Hedera testnet. Leave anytime; the registry doesn't care.

**Money flow (example):** 100 users × $10 = $1,000/mo pool. Avg user burns 500 × $0.001 requests = $0.50. Host cost ≈ $50. Spread covers facilitator gas + protocol fee + surplus (surplus → host rewards / lower fees; NOT user yield — no securities story).

**Core loop per prompt:**
1. User/agent sends prompt to gateway (Privy-authenticated).
2. Gateway scores registered hosts (price, latency, stake, reputation) → picks one → fallback on failure.
3. Gateway pays host's x402 route from the user's **scoped Hedera budget account** (allowance-capped, keys in Ledger Key Ring).
4. Host serves from its model, returns completion; receipt hash logged (HCS + explorer).
5. Host withdraws earnings; user sees flat subscription + usage stats only.

## 2. Architecture + repo layout

```
User / Agent (Privy embedded wallet)
  │  subscribe (USDC) → credits in SubscriptionVault
  ▼
Web app (Next.js, scaffold-hbar) — chat, explorer, team pool, Ledger approvals
  ▼
Gateway (fork PoC packages/service) — registry read, score, route, x402 pay, receipts, SSE
  ├─reads──▶ HostRegistry (Hedera testnet, Solidity via Hardhat/Foundry)
  ├─debits─▶ SubscriptionVault credits + per-user Hedera budget account (allowance)
  └─routes─▶ Hosts (compose: Ollama :11434 + x402 guard + registration script)
               │  serve → settle x402 via Blocky402 → receipt → HCS log
               ▼
Explorer (receipts, hosts, prices, spend) + Agent demo script (budget-capped autonomous payer)
```

Monorepo:
```
trulyopenrouter/
├── contracts/          HostRegistry.sol, SubscriptionVault.sol, deploy scripts, HashScan links
├── gateway/            fork of PoC packages/service: registry client, scorer, metered pricing, receipts, SSE
├── host-runner/        docker-compose.yml (ollama + guard), register.sh, MODEL_DIGEST pinning
├── web/                scaffold-hbar Next.js: Privy auth, chat UI, explorer, team pool, Ledger approval panel
├── agent-demo/         budget-limited agent (Hedera Agent Kit) that discovers + pays autonomously
├── docs/               README (setup/arch/payment flow), SELF-HOST.md, DX-FEEDBACK-ledger.md, FEEDBACK per sponsor
└── video/              ≤5min demo script + raw takes
```

## 3. Contracts (Hedera testnet, EVM Solidity)

**HostRegistry** — permissionless entry, verifiable hosting.
- `register(endpoint, modelId, modelDigest, imageDigest, pricePerReq, pricePer1kTokens, teePubkey)` payable (stake in HBAR/USDC).
- `updatePricing(...)`, `heartbeat()`, `deregister()` (unstake → timelock → **Ledger-tapped** release, see §8).
- `challenge(host, receiptId, proof)` → slash queue (stub ok: queues + event, no auto-slash).
- Events: `HostRegistered`, `HostUpdated`, `HostChallenged`, `HostRemoved`. View: `eligibleHosts(modelId)`.

**SubscriptionVault** — flat fee in, metered debits out.
- `subscribe(planId)` payable USDC → mints credits (e.g. $10 = 10,000 credits @ $0.001).
- `authorizeDebit(user, maxAmount)` / `debit(user, host, amount, receiptHash)` (gateway role only).
- `withdraw(host)` earnings; `refund(user)` unused credits; team-pool accounting map.
- Events: `Subscribed`, `Debited`, `HostPaid`, `Refunded`. All amounts + receipt hashes queryable (explorer fuel).

## 4. Gateway (the fork — PoC gives us 70%)

Base: PoC `packages/service` (Express + `@x402/express`, `@x402/hedera`, `@x402/core` ^2.18.0). Keep its 402→verify→proxy skeleton; ADD:
- **Registry client:** read `eligibleHosts(modelId)`, cache + refresh; reject digest mismatches.
- **Scorer:** `score = w1*price + w2*latencyEMA + w3*stake + w4*reputation` (reputation from local receipt log v1; Subgraph only if time — Graph is NOT a picked sponsor, keep explorer local).
- **Metered pricing (Hedera extra-points item):** price = `pricePerReq + tokens/1000*pricePer1kTokens` (token count from model response `usage`). PoC is flat $0.001 — metering is our delta, say so in README/video.
- **x402 client-per-user:** gateway holds per-user Hedera **budget accounts** (ECDSA, allowance-capped, keys in Key Ring). Per request: build `TransferTransaction` (USDC testnet `0.0.429274`), sign with budget key, retry with `PAYMENT-SIGNATURE: base64(tx)` header against the host's route. Facilitator: **Blocky402 testnet `api.testnet.blocky402.com`** (qual REQUIRES settlement through Blocky402 — PoC default `x402.org` testnet does NOT satisfy this; override via env).
- **Receipts:** `receiptHash = sha256(promptHash, completionHash, modelDigest, host, price, latency)` → HCS consensus log (Hedera SDK) + local DB for explorer. Prompt/completion bodies NEVER onchain.
- **SSE stream** (copy PoC): `connecting → routed → payment required → signing → submitted → model running → settled`, plus `host` + `price` + HashScan link per bubble.
- Endpoints: `POST /api/chat` (web app, Privy session), OpenAI-compatible `POST /v1/chat/completions` + `GET /v1/models` (Bearer `tor_sk_…` keys — any harness via `OPENAI_BASE_URL` + `OPENAI_API_KEY`), `GET /api/hosts`, `GET /api/receipts`, `POST /api/keys` (issue), `DELETE /api/keys/:id` (revoke). x402 stays downstream (gateway→host), invisible to key holders.

## 4b. API keys (OpenAI-compatible — the harness distribution story)

- Format `tor_sk_<32B base62>`; store key-prefix (first 8 chars) plaintext for lookup + salted
  SHA-256 hash for verify (constant-time compare). Reveal ONCE at creation, never again.
- Scopes per key: model allowlist (default: all registered), spend cap in credits (default: user
  quota), expiry (default: none; team keys 30d), req/min rate limit.
- Request path: `Authorization: Bearer tor_sk_…` → prefix lookup → hash verify → scope/cap/expiry
  check → same route+debit pipeline as web chat → receipt tagged with key prefix (per-key usage,
  leak forensics).
- Compatibility: `chat/completions` (plain JSON + `stream:true` SSE), `/v1/models` (registered
  models + live $/req extras). OpenAI-shaped errors: `invalid_api_key` 401, `insufficient_quota`
  429, `model_not_found` 404.
- Harness setup = 2 env vars, works with anything speaking OpenAI (opencode custom provider,
  Cursor, Cline, codex-style CLIs):
  `OPENAI_BASE_URL=https://<gateway>/v1` + `OPENAI_API_KEY=tor_sk_…`.
- Rotation = create + revoke (revocation instant, old key 401s immediately). Agent demo (§6) runs
  on a scoped demo key — the demo IS the integration proof.

## 5. Host runner (self-host = the decentralization proof)

`host-runner/docker-compose.yml`: `ollama` (OpenAI-compatible `:11434`, pinned `MODEL_DIGEST`) + `guard` (x402 resource server per PoC `x402.ts`, one route per asset) + `register.sh` (calls `HostRegistry.register`).
- Genesis hosts (team GPUs/Macs): 2–3 hosts, DIFFERENT prices/speeds so routing visibly matters.
- Join flow: clone → `MODEL=... PRICE=... ./register.sh` → stake → appear in explorer in minutes. Video moment: 3rd laptop joins LIVE.
- Kill-host failover: stop host #1 mid-chat → gateway reroutes → receipts prove it. (Second video moment.)

## 6. Web app + agent demo

- **Onboard (Privy, 30s):** email/social → embedded wallet → subscribe ($10 test USDC) → chat. No seed phrases anywhere.
- **Chat:** model picker (only registered `modelId`s), SSE tracker with host/price/HashScan badge, spend counter vs fair-share quota.
- **Explorer:** hosts (stake, endpoint, model digest, price, latency, uptime), receipts (hashes only), pool stats.
- **Team pool (Privy B2B):** organization wallet + policies (transfer caps, allowlists) + quorum/intent approvals for spends over threshold. See §8 Privy for Enterprise-gating fallback.
- **Ledger panel:** pending high-risk actions (unstake, withdraw, price change) show "awaiting Ledger tap"; withdrawal stays blocked until `wallet-cli send --data` confirms on-device.
- **Agent demo:** Hedera Agent Kit script with hard budget cap: discovers gateway (registry + recipe doc), pays x402 autonomously for N prompts, stops at cap. This is the Hedera "platform that consumes the service" requirement.

## 7. Economics + anti-abuse

- Credits: 1 credit = $0.001. Plans: $10 = 10,000 credits. Overage: top-up or throttle (never surprise charges).
- Host split: 90% host / 10% protocol (gas + registry upkeep). Publish split onchain.
- Fair-share: per-user rolling quota (e.g. 2,000 req/day) enforced in Vault; whale drains pool → throttled, pool survives. (World Selfie Check NOT integrated — cut with World; say quotas are the v1 answer.)
- Slashing (stub): failed-receipt challenges queue; no auto-slash at hackathon (say so openly).

## 7b. Model-identity verification (spot checks — the "actually served" proof)

- Problem: a host can register model X's digest while serving cheaper weights under X's name.
  Registration-time digests don't prove serving-time reality.
- Mechanism: deterministic fingerprint probes (temperature 0, fixed seed 42, tiny max_tokens)
  against reference outputs captured from a trusted run of the pinned serving stack
  (`scripts/capture-references.mjs` → `gateway/references.json`, keyed by exact modelId).
  References are bit-for-bit stable across runs (verified); model quirks (stable wrong answers)
  are features, not bugs — they're the fingerprint.
- Policy: battery majority + threshold (0.6) + 3 consecutive failing rounds convicts. Transport
  errors are inconclusive (never failures). Single bad rounds never convict.
- Enforcement: failing hosts leave routing rotation immediately (directory still lists them,
  flagged); auto-challenge onchain only when explicitly enabled (`VERIFY_AUTO_CHALLENGE=1` +
  registry + operator key) — contract queues for review, never auto-slashes.
- Probes travel the paid path (hosts earn for them, receipts log them) — verification traffic
  is transparent, not hidden. Sampling loop env-gated (`VERIFY_INTERVAL_MS`, off by default);
  manual trigger `POST /api/verify/:address` (explorer "Verify now").
- Limits (say openly): no logprobs on Ollama compat (unchecked upstream) → completion matching
  only; references valid per serving stack (Ollama version + quant) — re-capture when the
  host-runner image changes; cross-stack mismatches are signal, not proof.
- Same battery/format works for exo-chained company fleets (identical chat interface) —
  only the reference set differs per modelId. See design doc §9.
- Cut: Fireblocks operator treasury (no sponsor, no integration — every dependency must serve
  a prize leg; operator keys stay in Key Ring).

## 8. Sponsor implementation guides (WHAT + HOW + qual checklist)

### 8a. Hedera — AI & Agentic Payments ($6k, up to 3×$2k) [CORE — must be perfect]

WHAT the judges demand: live x402-gated service on Hedera testnet/mainnet **settled through the Blocky402 facilitator** + a platform/agent consuming it end-to-end. Public repo + README (setup, architecture, payment flow) + ≤5min video of the paid request.
- Native vs EVM split: x402 payments = NATIVE Hedera (`TransferTransaction` of HTS USDC/HBAR via `@hiero-ledger/sdk` + `@x402/hedera`, facilitator-settled — no EVM involved, this is the prize core). Registry/Vault contracts = EVM Hedera (Solidity, app state). Receipt audit = native HCS. Same testnet, complementary.
- HOW (ordered, from PoC + x402-on-Hedera docs):
  1. `portal.hedera.com`: 2+ ECDSA testnet accounts (agent-payer/service-receiver per host + deployer); fund HBAR via `faucet.hedera.com`.
  2. USDC association on every account (`scripts/associate-token.ts` pattern); fund payer via `faucet.circle.com` (Hedera testnet). Token IDs: testnet USDC `0.0.429274`.
  3. Fork PoC. Point testnet routes at Blocky402: `X402_TESTNET_FACILITATOR_URL=https://api.testnet.blocky402.com` (PoC default `x402.org` FAILS the qual — flag in README that we overrode it deliberately). Smoke-test: `curl` route → expect 402; `GET /supported` on facilitator → expect `hedera:testnet` kinds. Same spike: check `/supported` for any EVM-scheme Hedera kinds — if present, an EVM x402 payer via Privy wallet (same key, EVM door) is possible; if absent, native-only (expected, PoC-proven).
  4. Extend PoC flat-$0.001 to metered pricing (§4) — explicit extra-points item ("metering rather than flat").
  5. HTS in path: settle in testnet USDC (HTS token) — satisfies "HTS tokens in settlement path" extra point.
  6. HCS audit receipts (§4) — "verifiable payment audit trails on HCS" extra point.
  7. Agent demo (§6) with budget cap — the "platform/agent consumes service" requirement. Drop A2A/ACP + UCP discovery in as a registry README section (cheap extra-points signals; implement only if free).
  8. Video: ONE continuous take — subscribe → chat → 402 paid → HashScan tx → host paid. No cuts during payment.
- Extra-points we claim: metered pricing, HTS settlement, HCS audit trail, scoped budget accounts (= "allowances" narrative from Hedera's x402 blog). We do NOT claim: A2A/ACP, ERC-8004/HCS-14, UCP, scheduled txns (roadmap slide only).

### 8b. Privy ($2.5k B2B + $2.5k flow) [LOCKED — the first 30s of video]

WHAT the judges demand (both tracks): Privy core to product + ≥1 Privy wallet + working demo + code + "how Privy enables it" writeup. B2B additionally: org/business use case + ≥1 functional B2B workflow + ≥1 control (policies, signers, key quorums, intents). Flow additionally: ≥1 functional financial flow using a **generally available** feature (mocked commercial/guided-onboarding features DON'T count).
- HOW (from current Privy docs; note: old quickstart URL 404s — docs restructured, resolve via `docs.privy.io/llms.txt` at build start):
  1. Embedded wallets (GA): email/social onboarding → per-user EVM wallet → subscribe/top-up. This is identity + subscription payment, NOT x402 signing (Hedera budget accounts do that, §4 — document the split honestly).
  2. Financial flow (GA, the safe qualifier): fund wallet (crypto deposit / onramp where GA) → swap/transfer USDC for subscription. Must be live, not mocked.
  3. B2B workflow: team org → organization wallet (`entity: {type: organization}`) → policies (`policy_ids`: caps, allowlists) → server authorization key as `additional_signers` with `override_policy_ids` for auto-approved micro-spends → intents for async human approval over threshold (treasury recipe pattern).
  4. ⚠️ GATE: "Manual approvals (Dashboard)" is an **Enterprise** feature (`sales@privy.io`). Our required qualifier must NOT depend on it. Fallback ladder: (a) Intents API self-built approval UI (verify GA at build start); (b) if intents also gated, enforce quorum in OUR Vault contract with Privy embedded wallets as approvers + use Privy policies (GA) as the submitted "control". Decide at build start, document the choice.
  5. Webhooks for deposit/approval events → ledger-balance UI updates (policy/ops polish).
- Claim: embedded wallets + funding/swap flow + org wallet + policies + (intents or contract-quorum). Mock nothing that counts.

### 8c. Ledger — AI Agents x Ledger ($3.5k: $2k/$1k/$500) [LOCKED — highest entropy]

WHAT the judges demand: NEW project where device-backed security is central; MUST build on the Ledger Agent Stack, specifically **`wallet-cli ring`** for the starred directions; repo runnable without the team (or recorded walkthrough); **DX feedback doc judged as heavily as code** (`docs/DX-FEEDBACK-ledger.md` from day 1).
- HOW (verified against wallet-cli docs, CLI `v2.1.0`):
  1. `npm i -g @ledgerhq/wallet-cli` + `wallet-cli skill install --agent <cursor|claude>` (skill ships embedded; `skill doctor` for drift). Device: USB + relevant app; `genuine-check` once.
  2. `WALLET_PASS=$(<keychain lookup>) wallet-cli ring init` — ONE device tap, password NEVER literal (no shell history/ps/logs/transcripts; agent never handles the value — human provisions it).
  3. Secrets in ring: upstream provider keys, Hedera operator/budget-account keys, gateway signing keys (AES-256-GCM, files or stdin/stdout). VPS enrollment: provision on laptop → ship `.enc` → headless `ring decrypt` at boot (network needed for trustchain restore, NO device). = "Key Ring on hosts with no USB port" + "secrets agents can't leak" (broker hands scoped caps, never raw keys).
  4. Human-in-the-loop: high-risk actions via `wallet-cli send --data` (EVM calldata) with on-device review — unstake release, Vault withdraw over threshold, host price changes. Web panel shows blocked-until-tap state.
  5. Keep `ring keys` / `session view` hygiene; `session reset` in CI. Never `--unsecure-no-password` with real data.
- Video beat: gateway boots decrypting headless → withdrawal attempted → BLOCKED → Ledger tap → executed. 30 seconds, no cuts.

## 9. Build phases (ETHOnline Sep 4–16)

- **Day 1 (spikes, kill fast):** Blocky402 testnet `402` round-trip (curl smoke tests from PoC); faucet reliability (HBAR + Circle USDC); Privy docs resolve (`llms.txt`) + intents/policy GA check; `ring init` on the team device. Kill/swap per sponsor-picks triggers by EOD.
- **Days 2–4:** contracts (Registry+Vault) on testnet + gateway fork (registry read, scorer, metered pricing, Blocky402 override, SSE) + 2 genesis hosts on team GPUs/Macs.
- **Days 5–7:** web app (Privy onboard → subscribe → chat → explorer), team pool, Ledger panel + VPS enroll, agent demo, HCS receipts.
- **Days 8–9:** videos (Hedera payment take, Ledger tap take), READMEs per sponsor qual, DX-FEEDBACK-ledger.md, HashScan links, submission forms.
- **Stretch (only if core is done): Hedera track-stack.** Hedera is ONE pick covering ALL its tracks — our x402 build already qualifies for $6k; parking Vault float in an ATS treasury vault (issue → coupon/yield → redeem demo on testnet) opens the second $6k Tokenization track with zero extra sponsor slots. Heavy SDK; attempt only with a full spare day, x402 stays the priority.

## 10. Risks & fallbacks (decided, not debated mid-build)

| Risk | Fallback |
|---|---|
| Blocky402 testnet down/unsupported | x402.org facilitator for demo honesty + shift money-leg emphasis to Arc testnet (pre-agreed, still EVM) |
| Faucets dry | Pre-fund day 1; HBAR-first routes (native, no association) as backup if USDC association stalls (note: verify HBAR support on Blocky testnet endpoint first) |
| Privy intents/quorum Enterprise-gated | Contract-enforced quorum + Privy policies (GA); document, mock nothing load-bearing |
| Privy: Hedera not a default chain (295/296) | Configure custom chain via `defineChain` + own RPC override (Hedera JSON-RPC relay); managed extras (gas sponsorship, swaps, simulation) assumed UNAVAILABLE on custom chain — qualifier flow = plain transfer, never swap |
| Privy: HTS USDC association per wallet | Auto-associate step for new embedded wallets (service-side script) before first funding; day-1 spike: Privy wallet → associate → receive → transfer on testnet |
| Privy: key-quorum "reach out" friction, docs churn | Day-1 spike: create quorum + policy via API on free tier; resolve all doc URLs via `docs.privy.io/llms.txt` (old quickstart 404s) |
| No Ledger device on demo day | Pre-record the tap take; Ledger→ENS swap only if device lost before recording |
| LM Studio (desktop) unusable on VPS hosts | Ollama `:11434` (OpenAI-compatible) as the headless default; LM Studio stays laptop-only |
| 70B temptation | Banned. 8B only. |

## 11. Submission artifacts (per sponsor qual)

- Public monorepo + root README (setup, architecture diagram, payment-flow section) + `SELF-HOST.md` (clone→compose→register→serve).
- Hedera: README payment-flow + ≤5min video with live paid request + HashScan links.
- Privy: demo + code + "how Privy enables it" + live GA financial flow + B2B workflow with ≥1 control.
- Ledger: runnable repo (or full walkthrough recording) + `docs/DX-FEEDBACK-ledger.md` + `wallet-cli ring` load-bearing (not branding).
