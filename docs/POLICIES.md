# Policies — what they are, who enforces them, and where

Short version: **the blockchain enforces money and signatures; our gateway
enforces team policy; Privy enforces per-transaction wallet limits.** Nothing
about regions, models, or daily caps lives onchain.

## The three enforcement layers

| Policy | Set where | Enforced by | Enforced where | Onchain? |
|---|---|---|---|---|
| Member allowance (credits) | /team → Members → Edit cap | Gateway `SpendCapStore` (`gateway/src/allowances.ts`) | Pre-flight check per request; over cap → `429 quota_exceeded` | No |
| Org daily ceiling | /team → Firm rules → Daily ceiling | Gateway `orgrules.ts` | Per request; over → `429` | No |
| Allowed models / regions / verified-only / rate / pinned hosts | /team → Firm rules | Gateway org-rules gate (`gateway/src/index.ts` ~365) | Per request; violation → `403 org_policy` with a plain-language reason | No |
| Per-tx USD cap on the team wallet | Team creation (`capUsd`) | **Privy**, not us | At signing time: Privy refuses to sign a tx over the cap | No — Privy-side |
| Per-tx display cap | /team → Firm rules | Nobody (display only) | — | No |
| Subscriptions, relay payment, withdraw, stake | Contracts | **Hedera contracts** (Registry `0xa454…`, Vault `0xd75c…`) | Consensus | **Yes** |
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

Every chat/completion request passes two gates in `gateway/src/index.ts`:

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

## Mental model

```
chain      = money + signatures (trustless, slow to change)
gateway    = team policy per request (fast, operator-controlled)
Privy      = per-tx signing limits (key-custody boundary)
our server = identity + roles via signed messages (no keys held)
```
