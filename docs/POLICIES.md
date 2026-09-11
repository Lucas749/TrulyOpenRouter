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
| Team wallet transactions | /team → Treasury → Wallet limits (owner proposes, financial approver authorizes) → Privy policy + key quorum | **Privy**, not us | At signing: only allowed purchases, refunds, and capped payouts to approved recipients, with the financial approver and the broker key | No — Privy-side |
| Agent limits (credits per day, month, lifetime, request; models; rate; concurrency; key expiry) | /agents | Gateway durable counters in Postgres | Before any host is paid; over an approvable limit → `403 approval_required` | No |
| Host payment terms (x402) | Gateway env bounds | Gateway payer | Before signing each host payment | No |
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
Do not expire pending billing reservations automatically. Confirm the receipt,
USDC transfer, and vault debit before removing the exact payer/request entry.

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

## 3. What Privy enforces: the team treasury

Each team gets a Privy organization wallet owned by a key quorum that needs two
signatures: the team's financial approver (their Privy login) and the gateway's
broker key (`PRIVY_BROKER_AUTH_KEY`). The broker key alone cannot move funds;
the live check confirms Privy refuses it. The policy attached at creation
(`treasuryPolicyRules` in `gateway/src/treasury.ts`) denies by default and
allows only `eth_signTransaction` for:

- `subscribe(planId)` on the vault at each configured plan's exact price;
- `refund()` on the vault;
- HBAR payouts to approved recipients up to `TEAM_PAYOUT_CAP_HBAR`;
- test USDC `transfer` to approved recipients up to `TEAM_PAYOUT_CAP_USDC`.

An owner or manager proposes an intent with fully prepared terms (nonce, gas,
and gas price). The financial approver authorizes it with their session, the
broker co-signs, and the gateway checks the signed bytes against the reviewed
terms, stores them, and only then broadcasts to Hedera. Reconciliation checks
the same transaction hash, and an intent is confirmed only after its receipt.
A refund waits while any request billed to the team is unresolved. A wrong
destination, chain, function, amount, or recipient fails at Privy with
`policy_violation` (`gateway/scripts/treasury-policy-live.mts`).

Each team sets these limits itself. On the team page an owner proposes the
allowed plans, the per-transaction HBAR and test USDC payout limits, and the
approved recipients. The change runs as a Privy policy intent that the financial
approver and the broker key authorize, and the gateway records the new limits
only after Privy stores exactly the reviewed rules. Recipients can never be the
vault, the test USDC token, or the team wallet itself. `TEAM_PLAN_IDS` lists the
plans a team may choose from, and `TEAM_PAYOUT_CAP_*` only seed new teams.

Privy policies bound wallet transactions, not inference. Inference spend is
bounded in credits by the gateway layers above. The **Per-transaction display
cap** in Firm rules remains a label only (`per_tx_cap_usd` is never read by the
gateway).

## 4. How "who may click what" is enforced (no chain involved)

Membership actions (invite, set cap, set role, remove, approve increase, set
rule) are authorized by **EIP-191 `personal_sign`** over a canonical message
(`web/lib/member-messages.ts`: action + sorted `key: value` lines + expiry).
The server recovers the signer with `viem` and checks role rank
(owner 2 / manager 1 / member 0) in `web/lib/members.ts`. The signature binds
the exact parameters (org, did, wallet, role, cap…), so a signed "set cap 100"
cannot be replayed as "set cap 9999" or on another org. Expiry is 5 minutes.
Approving an increase request and raising an allowance need an owner; managers
may invite members, lower allowances, and deny requests. Rule changes bind the
exact bytes the page signs, only an owner of the team a change belongs to can
decide it, and each change is stored on its own so concurrent decisions cannot
overwrite each other.

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

## 7. Who pays?

Each request names one payer, and the gateway verifies it before routing:

- **Personal credits.** A verified Privy session with a linked wallet spends
  that wallet's own vault credits. Zero balance → `402 payment_required`.
- **Team credits.** `tor_team: <orgId>` spends the team wallet's vault credits.
  The gateway resolves the member from the verified session, requires an
  active team wallet, and reserves against the member's monthly allowance (the
  member's own value, or the team default) in Postgres. Outsiders and removed
  members cannot select the team.
- **Agents.** A `tor_sk_agt_` key spends either a team's credits within its
  sponsoring member's allowance, or its own personal budget account.

The team buys credits through a treasury intent (section 3). Settlement debits
the payer's vault credits per receipt, so nobody spends what was never
deposited. `SubscriptionVault` also carries `poolSpendCaps` and `debitFrom` as
an onchain per-member backstop for pooled funds; the gateway's durable counters
are the enforcer for team credits today.

## Mental model

```
chain      = money + signatures (trustless, slow to change)
gateway    = team policy per request (fast, operator-controlled)
Privy      = team wallet quorum + transaction policy (key-custody boundary)
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

## Agents, strict limits, and approvals

Agents authenticate with `tor_sk_agt_` keys. The gateway stores only a salted
hash, and rotating or adding keys never resets usage. Each admitted request
reserves its maximum credit cost on every counter that applies (the agent's UTC
day, month, and lifetime, plus the sponsoring member's month for team agents)
in one Postgres transaction, before any host is paid. Settlement moves the
actual cost from reserved to spent. A payment with an unknown outcome keeps its
reservation until reconciled; age never releases it.

A request over an approvable credit limit receives `403 approval_required` with
an approval ID, the exact constraint, remaining credits, the additional credits
requested, a review URL, and a polling interval. One open approval exists per
agent, request, and policy revision. Approvers:

- **Team spending:** an active owner of the same team signs the server-built
  message with a linked wallet. No Ledger is needed, including for agents that
  have one enrolled.
- **Ledger route:** the enrolled device signs the exact message through Ledger's
  Device Management Kit over WebHID.

An approval creates a single grant, claimed by exactly one retry of the
original request with the same idempotency key. Policy, membership, or
enrollment changes cancel open approvals. Widening a Ledger-protected agent
needs its Ledger, except that a team owner may raise a team agent's credit
limits within team rules. Approvals never move funds or change Privy policies.

## Personal agent budgets

A personal agent spends from its own budget account, derived from
`BUDGET_MASTER`. The owner deposits HBAR from their wallet, and deposits stay
HBAR until the owner buys a plan: the broker signs `subscribe` with the budget
key only when the balance covers the price plus a fee reserve. Returning funds
refunds unused credits, then sends the HBAR to one of the owner's linked
wallets and nowhere else. A Ledger-protected agent's return also needs its
Ledger to sign the destination and enrollment. Each leg's signed bytes are
stored before broadcast, so a retry resumes instead of repeating, and a return
waits while any request billed to the budget is unresolved.

## Host payment bounds (x402)

A host's 402 response does not authorize arbitrary payment. Before signing, the
gateway payer (`gateway/src/payer.ts`) requires:

- the exact scheme on `hedera:testnet` in test USDC (`0.0.429274`);
- an amount no higher than `X402_MAX_PAYMENT_UNITS` (default 10000, $0.01);
- a facilitator fee payer other than the gateway's payment account;
- a payee account whose EVM alias is the routed host's registered address;
- a payment account holding at least the amount;
- room under the shared daily ceilings `X402_DAILY_CAP_UNITS` and
  `X402_DAILY_PAYMENTS`.

A refusal before signing releases the request and returns a service error,
never a claim that the user's balance is empty. A host that rejects a sent
payment leaves the request for reconciliation.

## Broker secrets on the Key Ring

With `SECRETS_BACKEND=ring`, the gateway decrypts `gateway/secrets/*.enc`
through `wallet-cli ring` at boot. `BUDGET_MASTER`, `X402_PAYER_KEY`, and
`PRIVY_BROKER_AUTH_KEY` never fall back to environment values: a missing file or
failed decryption removes the environment value and leaves agent budgets, host
payments, or the team treasury disabled. `gateway/scripts/ring-runtime-check.mts`
demonstrates this on a ring member without printing secrets. The deployed
gateway still reads environment secrets until its server is enrolled as a ring
member.

## Team hosts and collections

A team owner creates a one-time link code. The host operator runs
`tor-host team link <code>`, and the registered host key signs terms naming the
team, network, registry, host, destination team wallet, nonce, and expiry. The
gateway accepts the link only for an actively staked registration, and a host
belongs to one team at a time.

`tor-host collect` withdraws HBAR vault earnings to the host, then sends them to
the team wallet, keeping 0.5 HBAR on the host for fees. `tor-host collect --usdc`
sends test USDC after checking the team wallet can hold it. The gateway records
each leg only after verifying its receipt: a withdrawal stays **collection
pending** until a transfer from that host reaches the team wallet, and never
counts as received. Host keys stay on host machines; Privy controls the funds
only after collection.

## API keys

A key belongs to the Privy login that issued it. Only that login can revoke the
key or read its budget account, and a team can bind a key to a member only when
the member's own login issued it, because key prefixes are public in receipts.
Issuing never reuses an existing prefix. Keys issued before logins were required
keep working for chat; operators revoke them with `DELETE /api/admin/keys/:prefix`.
