# Self-hosting TrulyOpenRouter

Run your own host and serve models for USDC. ~20 minutes, most of it model download.

## Prereqs

- Docker Desktop, Node 22+, a Ledger (for paid mode at the end)
- A Hedera testnet account with a little HBAR (faucet.hedera.com)

## 1. Clone + stack

```sh
git clone https://github.com/Lucas749/TrulyOpenRouter && cd TrulyOpenRouter
docker compose -f host-runner/docker-compose.yml up -d ollama guard
docker exec $(docker ps -q --filter ancestor=ollama/ollama) ollama pull qwen2.5:0.5b
```

Guard is on `:4122`. In dev it serves open (no paywall) until you set `HOST_WALLET`.

## 2. Register onchain (stakes real testnet HBAR)

```sh
cd host-runner/cli
tor-host run --model qwen2.5:0.5b --stake-hbar 10 --endpoint http://YOUR_IP:4122
```

This registers you in `HostRegistry`, sets pricing, and starts heartbeats.
Check yourself on `/network`.

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
