# Policies — what they are, who enforces them, and where

Short version: **the blockchain enforces money and signatures; our gateway
enforces team policy; Privy enforces per-transaction wallet limits.** Nothing
about regions, models, or daily caps lives onchain.

## The three enforcement layers

| Policy | Set where | Enforced by | Enforced where | Onchain? |
|---|---|---|---|---|
| Member allowance (credits) | /team → Members → Edit cap | Gateway `SpendCapStore` + vault `SpendCap` mirror | Pre-flight `429` per request; `debit` reverts `SpendCapExceeded` past the cap | Yes, where the deployed vault supports `setSpendCap` (else `chainSynced:"skipped"`) |
| Org daily ceiling | /team → Firm rules → Daily ceiling | Gateway `orgrules.ts` | Per request; over → `429` | No |
| Allowed models / regions / verified-only / rate / pinned hosts | /team → Firm rules | Gateway org-rules gate (`gateway/src/index.ts` ~365) | Per request; violation → `403 org_policy` with a plain-language reason | No |
| Per-tx USD cap on the team wallet | Team creation (`capUsd`) | **Privy**, not us | At signing time: Privy refuses to sign a tx over the cap | No — Privy-side |
| Per-tx display cap | /team → Firm rules | Nobody (display only) | — | No |
| Subscriptions, relay payment, withdraw, stake | Contracts | **Hedera contracts** (Registry `0x5f83…` + legacy `0xa454…`, Vault `0xd75c…`) | Consensus | **Yes** |
| "This signature authorizes that action" | Every signed button | Chain (tx auth) + our server (`viem` recover) | See below | Half |

## 1. What the blockchain actually enforces

The chain is dumb on purpose. It checks two things:

- **Money moved correctly.** `subscribe()` locks HBAR and credits the pool,
  the relay delivers `msg.value`, `withdraw()` releases earnings. If the math
  is wrong the transaction reverts — no human involved.
- **Only the key holder signed.** A transaction from address X is valid only if
  signed by X's key. The chain does not know what an "owner" or "member" is.

Everything else — who may spend what, on which model, from which region — is
*our* software deciding whether to serve a request, before any chain
interaction happens.

## 2. What our gateway enforces (offchain, per request)

Before routing, every production chat request requires a verified Privy
session with a linked wallet, or a valid API key with its own funded budget.
Unverified body addresses cannot authorize spending. Anonymous requests return
401; insufficient credits return 402; unavailable balances return 503.
A persistent per-payer reservation prevents concurrent reuse of credits and
blocks retries after uncertain settlement. Only confirmed vault debits release
completions. Operator-funded verification probes require admin authentication.
See [payment flow and recovery](PAYMENTS.md).

Authenticated requests then pass two policy gates in `gateway/src/index.ts`:

1. **Member allowance gate** — looks up the caller's key prefix in the cap
   store (synced from /team via `syncCap`). Spent ≥ cap → `429`. Note the
   comment in code: this is a *pre-flight* check, one call can overshoot
   slightly since true token cost is known after generation. The onchain
   vault debit (`settle`) is the final backstop — the gate exists for clean UX.
2. **Org rules gate** — pinned hosts, allowed regions (observed IP geo first,
   self-reported region as fallback), allowed models, verified-only, rate
   limit, daily ceiling. Violation → `403 org_policy`, e.g.
   "Not allowed in your organization (…)".

Both read from Postgres (fall back to local JSON), so rules survive restarts
and apply to every gateway instance pointing at the same DB.

**Onchain mirror.** Every allowance mutation (add / edit / remove → cap 0 /
claim / approve increase / default change fan-out) also calls
`POST /api/admin/spend-caps`, and the gateway writes `setSpendCap` to the
vault for the member's wallet *and* their key-budget address: cap + period
from the effective allowance (null = uncapped clears, 0 = deny-all). From then
on `debit` reverts past the cap even if the pre-flight is bypassed. The mirror
is best-effort and reported per response as `chainSynced: synced|skipped|failed`
— chain txs are slow/external, and a pre-`SpendCap` vault (or dev without chain
config) 501s, which must never block team admin. The gateway gate stays the
primary enforcer; the chain is the backstop that cannot be skipped by a buggy
caller. Proven: 7 forge tests + a real anvil loop (subscribe → cap → debit ok
→ over-cap reverts → exact remainder works).

## 3. What Privy enforces (and why the per-tx cap is special)

When a team is created with a USD cap, we create a **Privy spending policy**
(`web/app/api/team/orgs/route.ts`): an `eth_sendTransaction` ALLOW rule with
`value lte <cap in wei>`, converted from USD at the indicative rate in
`web/lib/fx.ts`, attached to the team's wallet **at creation**. From then on:

- Privy holds the wallet key and **refuses to sign** any transaction whose
  value exceeds the cap. The enforcement point is Privy's signing service —
  our app never sees the key and cannot override it.
- Policy *changes* need quorum authorization signatures (roadmap; creation is
  app-authed, changes are not yet wired).

Consequences:

- The **Per-transaction display cap** in Firm rules is a *label only*
  (`per_tx_cap_usd` is never read by the gateway — see `web/lib/members.ts`).
  The real enforcement is the Privy policy from wallet creation. We keep the
  display row so the team sees the number where they set other rules.
- Privy policies cap **native-token sends** (HBAR here), not LLM inference
  cost. Inference spend is capped by layers 1–2 above, in credits.

## 4. How "who may click what" is enforced (no chain involved)

Membership actions (invite, set cap, set role, remove, approve increase, set
rule) are authorized by **EIP-191 `personal_sign`** over a canonical message
(`web/lib/member-messages.ts`: action + sorted `key: value` lines + expiry).
The server recovers the signer with `viem` and checks role rank
(owner 2 / manager 1 / member 0) in `web/lib/members.ts`. The signature binds
the exact parameters (org, did, wallet, role, cap…), so a signed "set cap 100"
cannot be replayed as "set cap 9999" or on another org. Expiry is 5 minutes.

Trust note on email invites: the claim signature proves *wallet ownership*;
the email is self-asserted and matched against an owner-approved invite. The
owner can rebind any member's wallet at any time. Right-sized for capped
testnet spend, not for hostile environments.

## 5. Regions and models: where the options come from

- **Allowed models** chips are live: `GET /v1/models` on the gateway, which
  lists its configured models (`MODELS` env) with live host counts, token
  volume, and prices. If only `qwen2.5:0.5b` shows, that is literally all the
  connected gateway serves right now.
- **Allowed regions** chips are live: `GET /api/hosts` merged `geo` +
  `region` fields. `geo` is *observed* — the gateway resolves the host's
  endpoint IP and looks it up (private/loopback/docker hostnames resolve to
  nothing, by design: skipped rather than mislabeled). `region` is
  *self-reported* — the host operator passes `tor-host run --region <slug>`,
  synced to `POST /api/hosts/:address/meta`. Empty list + "N hosts online,
  none report a location" means exactly that: serving hosts exist but neither
  signal is present. Enforcement compares the request's routed host against
  the allowlist the same way.

## 6. Could the rules be enforced onchain? What does x402 change?

Short answer: **total spend already is, per-request policy cannot be — and
x402 doesn't change that boundary.**

What x402 gives us: every inference is an atomic, signed payment
authorization (~$0.001). Because money moves per request:

- **Total spend is onchain-bounded today.** Callers prepay into subscription
  pools; the vault debit settles per receipt and reverts when the pool is
  empty. No policy needed: you cannot spend what was never deposited. The
  vault balance *is* the ultimate spend cap, enforced by consensus.
- **Each payment is attributable.** Receipts + HCS anchoring mean any
  gateway misbehavior (serving a disallowed model, ignoring a cap) leaves a
  signed, timestamped trail. Enforcement is offchain; *auditability* is
  onchain.

What x402 does NOT carry: the payment authorization has amount, recipient,
nonce — no field for "model qwen2.5" or "region eu". To gate those onchain you
would need a policy contract in the payment path (payer approves a PolicyVault;
each request calls `spend(model, region, amount)`, which checks stored rules
and forwards the funds) **plus an oracle for region** — the chain cannot see
IPs, so some trusted party must attest "this host is in eu". That buys you
consensus-stamped denials at the cost of gas + latency on every inference and
a new trusted party (the oracle), which is exactly the trust you were trying
to remove.

And Privy specifically: its policy engine gates *signing* (value ≤ cap on
`eth_sendTransaction` for the team wallet). It knows nothing about models,
regions, or credits. It cannot enforce firm rules; it was never in that path.

So "set the rules right and they're all enforced" is true today — the
enforcer is the gateway, per request, before serving. Moving that check into a
contract would make violations *impossible* instead of *detectable*, at a price
we'd feel on every call. Deliberate split, documented here so it stays
deliberate.

## 7. Who pays? (team money vs individual money)

Today: **every member pays individually.** The browser sends a verified access
token and selects its wallet with `userHandle`; the gateway checks server-side
wallet ownership and settles by debiting that wallet's own
vault credits — the subscription *they* funded (e.g. 10 HBAR → 10k credits).
Zero personal balance → `402 payment_required`.

Team allowances are **ceilings, not a pool**: they gate keyed (API) calls per
key prefix, and keyed calls settle against a derived budget account — not
against any shared org balance. A wallet-handle chat call is, per the code
comment, granted nothing by membership: caps "enforce exclusively via keys".

The org's Privy team wallet (created at team setup, with the per-tx policy)
exists but is **not wired as a payer** — nothing in the inference path debits
it. So there is currently no such thing as company money being spent; there
are only individual balances with team ceilings on top.

To make it company money, the missing piece is payer derivation with org
context: the request must say "member X acting for org Y", the gateway must
check Y's pool balance (funded once by the company) and X's allowance against
it, and settle debits Y's pool. Design decision sitting behind that: shared
pool (members draw freely up to caps) vs stipends (company tops up individual
balances). Either way the allowance machinery already exists — only the
funding source changes.

**Status: the contract half exists.** `SubscriptionVault` now has
`poolSpendCaps[pool][member]` + `debitFrom(pool, member, …)`: the org wallet
subscribes once (company funds it), each member draws within their own cap,
and members with NO entry are denied by default — an unknown or removed
member cannot touch pool funds, period. The pool's own balance and the daily
quota bound the org as a whole. Proven in forge (6 tests: draw-within-cap,
deny-by-default, cap-0 removal, period reset, pool-balance bound, gateway-only).
Not yet wired: gateway payer resolution with org context (request → (member,
pool) → `debitFrom`), pool funding UX (subscribe from the org wallet), and the
web mirror keyed by (pool, member). Until those land, live traffic still
settles per-member (this section's first paragraph).

## Mental model

```
chain      = money + signatures (trustless, slow to change)
gateway    = team policy per request (fast, operator-controlled)
Privy      = per-tx signing limits (key-custody boundary)
our server = identity + roles via signed messages (no keys held)
```

## Host routing settings

Hosts can sign a revision of their model, model digest, endpoint, and paused
state for the gateway. These are routing settings; the registry retains the
original registration and stake. The gateway verifies the host signature,
five-minute submission expiry, registry membership, active stake, original
model, and next revision before storing an update in Postgres. A signature
cannot change balances, stake, ownership, or another host's settings.

Pausing drains new routes without starting the stake release timer. Resuming
requires the registration to remain active. Model discovery includes signed
model updates; verification summaries are specific to the effective model.
Deregistering and releasing stake remain separate onchain actions.

## Testnet host funding

The onboarding funding button sends exactly 5 testnet HBAR from a dedicated
backend account. The web server verifies the login access token and forwards
the verified user ID through the private gateway admin API. The gateway checks
the host's account link, permits one grant per address and one new host per
login every 24 hours, and caps the pool at 10 grants per rolling 24 hours
(`FAUCET_DAILY_GRANTS`). Account links are metadata, not proof of key custody;
the verified-login and global limits bound the public testnet subsidy.

Postgres serializes reservations and saves the signed native transaction before
broadcast. Retries reuse its transaction ID and bytes, including after a restart.
Uncertain outcomes remain pending and reserve funds until consensus or mirror
history confirms the result. A failed or expired unresolved grant needs operator
review; do not delete it or sign a replacement without checking its transaction
history. An empty pool does not consume the user's eligibility.

`FAUCET_ACCOUNT_ID` and `FAUCET_PRIVATE_KEY` belong only on the gateway. This
wallet is separate from operator, subscription, and host funds. Each pending
grant reserves 5 HBAR plus a maximum 1 HBAR network fee. The service always uses
Hedera testnet. No contract deployment is involved.

## Host availability and payment receipts

An active registration does not prove a running machine. The gateway probes
each guard's health endpoint, caches the result for 15 seconds, and excludes
unreachable endpoints from serving counts and routing. `registeredActive`
retains the contract state; `active` also requires reachability and no signed
pause. `availability` exposes the check time and reported payment mode.

Registered CLI setup resolves the host's native account ID and enables its
x402 guard. A direct unpaid request receives HTTP 402. The gateway's payer
signs the USDC transfer and retries; the facilitator verifies it and settles
the host payment. The gateway then settles the user's subscription credits
through the HBAR vault. Receipts store the direct payment as `x402Transaction`
and the vault settlement as `debitTx`. Direct USDC reaches the host wallet;
the existing CLI withdrawal action releases the separate HBAR vault earnings.
