# Handover — TrulyOpenRouter (as of `3d2bd48`, 2026-09-10)

## What this is
Decentralized OpenRouter on Hedera testnet: users chat with LLMs through a
gateway that routes to permissionless hosts. Users prepay flat HBAR
subscriptions ($10 → 10,000 credits); hosts stake HBAR, serve models, earn
~90% per routed call. Teams get spend caps + firm rules (models/regions/
verified/rate/pinned hosts). All money movement settles onchain; all policy
gates run in the gateway per request.

## Architecture (trust in one paragraph)
- **Chain enforces money + signatures only**: `SubscriptionVault`
  (`0xd75c46c0e82115ab4d24326dbbbbffe4e7d0c576`) — subscribe/debit/withdraw/
  refund, per-user daily quota, per-account `SpendCap`, org-pool
  `poolSpendCaps` + `debitFrom`. `HostRegistry`
  (`0xa45461bdefef422a81b22f36ebfd0995c7642dc3`) — register/heartbeat/
  deregister. NOTE: onchain `MIN_STAKE` is dust (1e9 wei); the 5 HBAR stake is
  our CLI default, not consensus. Live vault **predates** `SpendCap`/
  `poolSpendCaps` — onchain caps activate at the next vault redeploy.
- **Gateway enforces policy** (offchain, per request): member allowances
  (429), org rules (403 `org_policy`), model allowlists, region allowlists
  (observed IP geo → self-report fallback), verified-only, rate limits, daily
  ceilings. Mirrors every allowance mutation onchain best-effort
  (`chainSynced: synced|skipped|failed` in API responses).
- **Privy enforces per-tx signing limits** (refuses to sign over-cap txs) and
  holds team wallet keys. Member auth = EIP-191 `personal_sign` over canonical
  messages, verified server-side. Full matrix: `docs/POLICIES.md` (read it).
- **x402** moves router→host per-call payments ($0.001 USDC); users never touch it.

## Infra (no secrets below — locations only)
- Web (Vercel): `https://trulyopenrouter.vercel.app` — manual `vercel --prod`
  from `web/`. Serves landing/chat/team/network/host pages + `/install.sh` +
  `/api/gw/*` proxy to the box gateway. Env: `GATEWAY_URL`,
  `GATEWAY_ADMIN_TOKEN`, Privy + Neon (`DATABASE_URL`/`POSTGRES_URL`, both accepted).
- Box (AWS us-west-2): EC2 `52.12.2.63`, gateway `:4121`, RDS Postgres. Same
  `GATEWAY_URL` target. One demo host (`0x00…01`, qwen2.5:0.5b, region
  `us-oregon` attached manually). Deploys: `docker-compose.prod.yml` + Caddy,
  `DEPLOY.md`. SSH key `tor-deploy.pem`, `.env.prod` — both gitignored.
- Repo: `https://github.com/Lucas749/TrulyOpenRouter`, small commits on `main`.

## What is built (this session worked newest-first)
- **Host onboarding E2E** (ACTIVE FIRE, see below): fullscreen TUI
  `quickstart.sh` (alt-screen app, live board, arrow-key model picker with
  remembered pick in `~/.tor/last-model`, hardware detect, auto cloudflared
  tunnel, Ledger optional, login with auto-open approve URL + immediate
  machine→account claim, fund-wait with live balance/Enter-recheck, idempotent
  retries, serving rundown board); `/host/onboarding` page (login, per-key
  balances, drip 0.5 + faucet links, auto-detect registration); user
  `/onboarding` (balance-gated subscribe, drip, friendly tx errors, no RPC
  dumps); `tor-host run` (keygen, funding check with gas headroom, idempotent
  register-skip, region auto-attach, owner claim); login binds host key at
  approval (zero pasting).
- **Onchain caps**: `SpendCap` + `setSpendCap` (29 forge tests), org pools
  (`poolSpendCaps` + `debitFrom`, deny-by-default, 6 more tests), anvil E2E
  proof (subscribe → cap → debit ok → over-cap reverts).
- **Gateway mirror**: `POST /api/admin/spend-caps` (address and/or key-prefix
  → budget account), vault writer, 7 route tests; web `syncSpendCap` on
  add/edit/remove/claim/approve/default-fanout with `chainSynced` reporting.
- **Teams**: email invites + wallet-signature claims, roles
  owner/manager/member, allowances, increase inbox, firm rules UI (collapsible),
  per-tx display cap (label only — real cap is the Privy creation policy).
- **Trust/ledger**: L1/L2 key ring, L3 broker, Hedera-only taps, `/security` UI.
- **Regions**: observed IP geo (private/loopback skipped by design) +
  self-report via `tor-host run --region` (now auto-detected from egress IP).

## ACTIVE WORK — host onboarding completion
**Goal**: fresh Mac → serving host, guided, zero dead ends.
**Works now**: steps 0–6, tunnel, login+claim (proven live incl. owners-index
readback), fund-wait loop, underfunded errors with address.
**Just fixed**: stake 5 / fund 6 so one faucet trip (10 HBAR) suffices —
previously exactly-10 keys failed the register tx on gas with zero visibility
(log truncation wiped the error; waits now append).
**To verify next**: full green run to "ROUTABLE" (blocked only on real testnet
funds + browser clicks, which can't be automated here).
**Known sharp edges**:
- `git pull -q || true` in `install.sh` swallows failures → stale clones;
  quickstart prints its rev in the session line — always ask for it.
- `tor-host` resolves to the repo checkout (npm link), NOT the installer
  clone — the clone's step-1 rebuild doesn't affect the binary; rebuild repo
  `host-runner/cli` after touching it.
- macOS `script(1)` batches piped stdin until EOF — pty timing tests lie;
  test logic, not timing, in harness.
- bash 3.2 + non-UTF8 locale: never put a multibyte char directly after
  `$VAR` (brace it). No `$VAR`+multibyte adjacencies remain (audited).
- `set -e` + background jobs: `wait … && rc=0 || rc=$?` pattern; children
  that don't need stdin get `< /dev/null` (they steal Enter presses).
- Fresh clones lack `.local/` (gitignored) — runtime files go to `mktemp -d`;
  never depend on repo state.

## Conventions (do not regress)
- Small commits on `main`, one idea each; verify (tsc + vitest + forge as
  touched) before every push; no attribution footers anywhere.
- money: 1 credit ≡ $0.001, divisor 1e5, `$ = units/1e8` (`web/lib/money.ts`).
- Mock rule: `?mock=1` swaps ENTIRELY + banner; unwired shows `—`/skeleton.
- Secrets never committed: root `.env`, `web/.env.local`, `.env.prod`,
  `*.pem`, `*.tfstate` all ignored.

## Key files
- `quickstart.sh`, `web/public/install.sh`, `host-runner/setup.sh` (legacy manual)
- `host-runner/cli/src/{run,login,link,index,ui}.ts`, `gateway/src/{index,orgrules,vault,allowances,geo}.ts`
- `contracts/src/{SubscriptionVault,HostRegistry}.sol`
- `web/app/{onboarding,host/onboarding,team/members,rules}/`, `web/lib/{members,member-messages,gateway-admin,tx-errors}.ts`
- `docs/POLICIES.md`, `docs/DESIGN-SECURITY.md`, `DEPLOY.md`, `.local/TEST-LIST.md`

## Useful commands
- Web: `npx tsc --noEmit && npx vitest run` (in `web/`); deploy `vercel --prod --yes`
- Gateway: `npx vitest run` (in `gateway/`); contracts: `forge test` (in `contracts/`)
- CLI: `npm run build && npx vitest run` (in `host-runner/cli/`)
- Box hosts: `curl -s http://52.12.2.63:4121/api/hosts`
- Anvil cap E2E: see runbook comment in `gateway/test/spendcaps-e2e.test.ts`
