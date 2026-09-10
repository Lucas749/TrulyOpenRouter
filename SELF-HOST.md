# Self-hosting TrulyOpenRouter

Run your own host and serve models for USDC. ~20 minutes, most of it model download.

## Prereqs

- Docker Desktop, Node 22+, `cast` (foundry), a Ledger (for paid mode at the end)
- A Hedera testnet account with a little HBAR (faucet.hedera.com)

## Easy path: one script

```sh
git clone https://github.com/Lucas749/TrulyOpenRouter && cd TrulyOpenRouter
sh host-runner/setup.sh
```

It prompts for your host key (hidden input, stays on your machine) and public
endpoint, then pulls the model, computes its digest, starts the stack,
registers onchain (4 HBAR stake + 1 HBAR gas reserve, 5 HBAR overall), verifies, and offers the heartbeat cron.
`--dry-run` prints every step without touching anything. Your endpoint must be
publicly reachable — LAN IPs won't route.

## Manual path (same steps, by hand)

### 1. Clone + stack

```sh
git clone https://github.com/Lucas749/TrulyOpenRouter && cd TrulyOpenRouter
docker compose -f host-runner/docker-compose.yml up -d ollama guard
docker exec $(docker ps -q --filter ancestor=ollama/ollama) ollama pull qwen2.5:0.5b
```

Guard is on `:4122`. In dev it serves open (no paywall) until you set `HOST_WALLET`.

### 2. Model digest (proves what you serve — the network spot-checks it)

```sh
docker exec $(docker ps -q --filter ancestor=ollama/ollama) ollama show --modelfile qwen2.5:0.5b | sha256sum
```

Prefix with `0x`. A host serving anything else gets drained out of rotation.

### 3. Register onchain (stakes real testnet HBAR)

```sh
export REGISTRY=0x5f83c19413fc15181e2e79512947e374c7b8dc56 RPC_URL=https://testnet.hashio.io/api
export HOST_KEY=<your-key> ENDPOINT=https://your-public-url MODEL_ID=qwen2.5:0.5b MODEL_DIGEST=0x…
export PRICE_PER_REQ_WEI=100000 PRICE_PER_1K_WEI=100000 STAKE_WEI=4000000000000000000
sh host-runner/register.sh
```

Units are delivered tinybars (relay sends value/1e10): 100000 ≈ 1 credit,
4e18 = 4 HBAR. Fund at least 5 HBAR overall to cover stake and gas. Check yourself on `/network`.

## 3. Get paid

Set `HOST_WALLET=0.0.you` on the guard and restart it. Now every call served
pays $0.001 testnet USDC to your wallet via x402. Watch it land on HashScan.

## 4. Leave (and get your stake back)

```sh
tor-host leave            # deregister → timelock → release → stop
tor-host leave --dry-run  # plan first, touch nothing
```

The timelock is contract-enforced. In our setup, stake release goes through the
Ledger tap queue (`/security`) — nobody's stake moves on a server whim.

## Cheatsheet

- Gateway health: `:4121/health`. Guard health: `:4122/health` (shows `payTo`).
- Claim the host in web: `tor-host login`, approve at `/host/link`.
- Fund a budget key for testing: `scripts/fund-budgets.mjs`.
- Something red? `/network` host detail shows verification + challenge state.
