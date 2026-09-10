# Handover — TrulyOpenRouter (as of the host controls rollout, 2026-09-11)

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
  (`0x5f83c19413fc15181e2e79512947e374c7b8dc56`) — register/heartbeat/
  deregister. Onchain `MIN_STAKE` is 4e8 tinybar = 4 HBAR. Legacy registry
  `0xa45461bdefef422a81b22f36ebfd0995c7642dc3` retains existing stakes. Hedera
  contract values use tinybar; JSON-RPC transaction values use weibars. Live vault **predates** `SpendCap`/
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
  `DEPLOY.md`. Local SSH key and deployment environment: `/Users/lucas/Desktop/vps-sandbox-access/`
  (`tor-deploy.pem`, `.env.prod`). Remote app: `/home/ubuntu/TrulyOpenRouter`.
  Rollback image: `tor-gateway:before-5hbar`; environment backup:
  `.env.prod.before-5hbar` on the box. Secrets and runtime files stay out of Git.
- Repo: `https://github.com/Lucas749/TrulyOpenRouter`, small commits on `main`.

## What is built (this session worked newest-first)
- **Host controls and visual polish (2026-09-11)**: terminal redraw replaces
  the full viewport, preventing old tab text from overlapping; the TOR banner
  is restored on larger screens. Web host dashboard uses the landing page's
  white, black, and neutral-gray palette. Vercel deployment
  `dpl_FBQM4YTAFKu7JuDyhHzra6uyNNp1` (code `a6c9730`) is ready; production
  desktop/mobile checks show no browser errors or horizontal overflow.
- **CLI lifecycle**: Controls has start (`s`), shutdown (`p`), restart (`x`),
  model chooser (`m`), software-key withdrawal (`w`), and Ledger approval (`l`).
  Equivalent commands: `tor-host start|stop|restart`, `tor-host model <tag>`,
  `tor-host withdraw [--ledger]`. Stop pauses new gateway routes before stopping
  guard, Ollama, and the managed tunnel. Start restores services/tunnel and
  enables routes only after model and endpoint readiness. Quickstart transfers
  tunnel process ownership and updates effective routing even for an existing
  registration. Managed PIDs are verified against process start time/command.
  Closing the console leaves services running. Model downloads retain files.
- **Signed routing state**: `host_runtime` stores model/digest/endpoint/pause
  revisions in Postgres. Exact host-key signature, five-minute submission
  expiry, active stake, registry, original model, and next revision are checked.
  Original onchain registration and stake remain unchanged; no contract redeploy
  was needed for these controls. Discovery includes updated models and model
  verification is specific to the effective model. APIs distinguish paused
  routing from active registration so the web never offers stake release merely
  because routing is paused. See `docs/POLICIES.md` and `host-runner/README.md`.
- **Earnings**: vault `hostEarnings` is credits, not tinybar. Available HBAR now
  uses the live `REFUND_RATE_WEI_PER_CREDIT`; compatibility field `earningsWei`
  carries tinybar. CLI also shows settled seven-day host earnings. Withdrawals
  quote all available earnings, destination, and maximum fee, then require a
  successful receipt; pending/reverted transactions stay explicit. The Ledger
  option verifies a USB device signature before the existing software host key
  submits on Hedera. It is local approval, not a hardware-held host key or
  onchain multisig. USB libraries load and enumerate successfully; no device
  was attached, so physical approval remains unverified. User funds were not
  moved. An isolated Anvil test proves nonzero withdrawal, host receipt of funds,
  cleared earnings, and rejection of a second empty withdrawal.
- **Validation and rollout**: CLI 70 tests plus the explicit Anvil withdrawal
  proof pass; terminal emulator checks cover stale rows and resizing. Gateway
  98 tests pass (9 database-dependent skips); a separate temporary-table test
  against production Postgres verifies runtime persistence and revision
  conflicts without changing real records. HTTP routing tests prove updated
  model/endpoint routing and pause exclusion. Shell suite: 13 pass. Web typecheck,
  targeted lint, and 5 dashboard tests pass. Gateway was rebuilt from committed
  sources and recreated; rollback image `tor-gateway:before-host-controls`.
  The remote checkout has no `.git`; deploy source archives, not `git pull`.
  Final read-only check of local host `0xe0D003aE8B216Bd3c1C45081598A24221F944F89`
  found Docker stopped, public endpoint offline, zero requests/earnings, and
  4 HBAR stake. Its services were left in that state. Live controls are available
  on reopening the console; physical start/stop was tested with service doubles.
- **Live host console (2026-09-11)**: quickstart opens the TUI immediately
  after registration. Reopen with `tor-host` or `tor-host dashboard`.
  Seven tabs cover overview, request activity, models, network, logs, controls,
  and help. Ten-second refreshes retain the selected tab and scroll position.
  The overview combines registration, local guard, downloaded model, and
  registered endpoint health. Recent receipts distinguish routed traffic from
  readiness. Unknown telemetry stays unknown; balances use HBAR.
  Controls start existing containers, pause the guard, or restart the guard /
  Ollama without recreating containers or moving funds. Closing the view leaves
  services alone. `tor-host status --json` exports public telemetry only.
  Quickstart retains setup/tunnel log paths in `~/.tor/monitor.json`, refreshes
  the installed launcher, and the hosted installer stops if Git updates fail.
  CLI: 59 tests pass; shell/terminal: 13 tests pass. PTY checks cover live
  request refresh, navigation, 40-column resize, plain output, input/cursor
  restoration, and pause/resume with simulated services. The actual local
  Dubai host passes all readiness checks with `qwen2.5:0.5b` and 0 requests.
  The final quickstart handoff is exercised separately without chain writes.
  Hosted installer deployment: `dpl_7nhSfhZupeoJgX2DQs1Bq6M49EK2`
  (code `e0bd942`); repository changes are pushed to `main`.
- **Host dashboard + map fixes (2026-09-11)**: the old dashboard rendered a
  404 body as a host and crashed on the missing address. Typed per-host states
  now retain pending registrations and failed lookups, with bounded requests
  and 15-second refreshes. The dashboard has HBAR balances, active host cards,
  setup recovery, address tracking, and mobile layouts. Damaged bookmarks are
  filtered; unknown balances stay unknown.
- **Host locations**: globe now recognizes gateway slugs such as `ae-dubai`
  and `us-oregon`, with labeled country-center fallbacks for other regions.
  Region controls reveal either hemisphere. The canvas and rotation persist
  across data updates; host lists refresh every 15 seconds. Missing locations
  are counted, and the fixed gateway marker / decorative traffic were removed.
  Live data shows 4 hosts: Dubai + Oregon mapped, 2 without reported regions.
  Browser checks cover the original mixed pending/registered crash, empty and
  damaged storage, mobile overflow, and a newly discovered region appearing
  without reload while the selected region stays focused. Web: 62 tests pass,
  2 database-dependent skips; typecheck and targeted lint pass. Production web
  deployment: `dpl_5gNzZ7vPpBgHPVScv25zJmVtiCph` (code `68949f2`).
  Network update labels use the actual refresh time, preventing hydration
  mismatches. Live desktop/mobile checks finish with no browser errors.
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
**Registration funding**: use the live registry minimum with Hedera's
8-decimal contract units, converted to the relay's 18-decimal transaction
value. The current minimum is 4 HBAR; keep another 1 HBAR for gas (5 total).
The immutable 10 HBAR registry was replaced on testnet. `LEGACY_REGISTRIES`
keeps old hosts discoverable; CLI resume/leave locate their original stake.
`TAP_REGISTRY` keeps device-approved actions on the existing demo host registry.
The vault address and balances are unchanged.
Quickstart reads structured funding details from its own freshly built CLI;
other registration failures stop immediately without another faucet loop.
**Docker readiness**: quickstart now checks the engine during dependencies,
opens Docker Desktop on macOS when needed, and waits up to 2 minutes with
setup guidance. Missing Docker/Compose and startup failures have explicit
recovery steps. Verified locally from a stopped engine to ready.
**Rollout verified (2026-09-11)**: production Vercel deployment
`dpl_9bfTJhsS8r1PHCt7xDy7hLyF7UEx` is ready; the gateway image was rebuilt and
recreated with the replacement registry. Hosted config plus the built CLI
produce a 5 HBAR target. Read-only registration simulation accepts 4 HBAR,
with gas estimated at 0.33 HBAR. Legacy host selection retains the original
stake. Both fresh installer and update-from-`64ad80d` checks reach the new
code; hosted chat returns HTTP 200 with a receipt. Checks: CLI 46, gateway 92,
web 51, contracts 36, shell/terminal 13 pass (11 database-dependent skips).
**To verify next**: a complete fresh-host interactive run through browser
approval and a real registration transaction. No transaction was sent from
the user's host wallet during this rollout.
**Known sharp edges**:
- Receipt IDs currently hash content and latency but omit payer/request identity.
  Identical completions at equal latency can collide; the wallet route fixture
  now uses a distinct prompt. Receipt uniqueness needs a separate fix.
- Quickstart now refreshes `npm link` after each build. If linking fails,
  the current install session uses its freshly built CLI directly and prints
  a launcher recovery command. Rebuild `host-runner/cli` after source edits.
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
- `host-runner/cli/src/{dashboard,monitor,monitor-view,monitor-logs,monitor-controls}.ts`
- `contracts/src/{SubscriptionVault,HostRegistry}.sol`
- `web/app/{onboarding,host/onboarding,team/members,rules}/`, `web/lib/{members,member-messages,gateway-admin,tx-errors}.ts`
- `docs/POLICIES.md`, `docs/DESIGN-SECURITY.md`, `DEPLOY.md`, `.local/TEST-LIST.md`

## Useful commands
- Web: `npx tsc --noEmit && npx vitest run` (in `web/`); deploy `vercel --prod --yes`
- Gateway: `npx vitest run` (in `gateway/`); contracts: `forge test` (in `contracts/`)
- CLI: `npm run build && npx vitest run` (in `host-runner/cli/`)
- Docker startup: `node --test host-runner/test/ensure-docker.test.mjs` (repo root)
- Box hosts: `curl -s http://52.12.2.63:4121/api/hosts`
- Anvil cap E2E: see runbook comment in `gateway/test/spendcaps-e2e.test.ts`
