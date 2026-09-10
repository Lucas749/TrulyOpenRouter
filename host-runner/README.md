# Host runner — serve a model on TrulyOpenRouter

Anyone with a GPU (or a Mac with Ollama) can join. Three steps, minutes.

Quickstart opens a live host console when setup finishes. Reopen it anytime:

```sh
tor-host
# or: tor-host dashboard
```

Use **1–7** or **← / →** to explore the overview, request activity, local models,
network, service logs, controls, and help. **↑ / ↓** scroll, **r** refreshes, **l** switches
the log source, and **q** closes the view. Closing the console leaves services
running. It refreshes every 10 seconds and keeps the selected tab in place.
On **Controls (6)**:

- **s** starts serving, restores the tunnel, and enables new routes.
- **p** shuts down the host: pause routes, stop guard/Ollama and its managed tunnel.
- **x** restarts the host and publishes its current endpoint.
- **m** changes the model; use arrows for downloaded models or type an Ollama tag.
- **w** withdraws earnings with the software host key.
- **l** requests Ledger approval, then submits with the existing host key.

Stop/start and model changes preserve the stake and current pricing. They use
host-signed routing settings, while the original registration remains onchain.
Model files remain on disk. Restarting interrupts requests already in flight.

The same controls are available as commands:

```sh
tor-host start
tor-host stop
tor-host restart
tor-host model deepseek-r1:8b
tor-host withdraw
tor-host withdraw --ledger
```

Withdrawals show the current balance, host-wallet destination, and maximum fee
before confirmation. They withdraw all available earnings, including any that
arrive before confirmation; stake remains locked. `--dry-run` shows a quote
without submitting, and `--yes` confirms noninteractive software-key use.
A pending or reverted transaction is never shown as a completed withdrawal.

For Ledger approval, connect the device, open its Ethereum app, and confirm the
address and message on the device. The first approval remembers its public
address; later approvals must use the same device address. This is local device
approval followed by a Hedera transaction from the software host key. It does
not move the existing host identity onto the device or add onchain multisig.
There is no automatic software-key fallback if device approval fails.
USB dependencies are optional so the CLI remains usable without a Ledger.

The overview checks the registered public endpoint, local guard, and Ollama.
“Ready to serve” means these checks pass; “Serving · recent traffic” means a
routed request completed in the last five minutes. Request counts, failures,
latency, and earnings come from the gateway. Unavailable data stays unknown.
Balances use HBAR. Health checks do not send paid inference requests.

For scripts or a quick snapshot, use `tor-host status` or `tor-host status --json`.
`tor-host dashboard --once` also works without an interactive terminal. Custom
setups may pass `--gateway`, `--guard-url`, and `--ollama-url`. `tor-host run`
opens the console after successful setup; use `--no-dashboard` for plain output.

## 1. Run a model

```sh
docker compose up -d
docker compose exec ollama ollama pull llama3.1:8b   # or qwen2.5:7b
```

CPU-only works for the registry join demo; GPUs serve real traffic.
`MODEL_DIGEST` = sha256 of `ollama show --modelfile <model>` output — pin it:

```sh
export MODEL_ID="llama-3.1-8b"
export MODEL_DIGEST="0x…"          # sha256 of the modelfile
export ENDPOINT="http://<your-ip>:11434"
```

## 1b. Mac hardware (Metal speed, still dockerized)

Docker Desktop on Mac has no GPU passthrough, so Ollama-in-Docker runs CPU-only. To earn
with full Metal speed: run the model natively, keep the guard dockerized.

```sh
# 1. Native inference (pick one):
ollama serve &                             # Ollama.app or brew ollama…
OLLAMA_HOST=0.0.0.0 ollama serve &         # …must listen beyond localhost
# or: exo cluster on the Mac (multi-device big models, :52415)

# 2. Dockerized paywall pointing at it:
docker compose -f docker-compose.mac.yml up -d --build
# exo instead: UPSTREAM_URL=http://host.docker.internal:52415 docker compose -f docker-compose.mac.yml up -d --build
```

Why `OLLAMA_HOST=0.0.0.0`: the guard container reaches your Mac via `host.docker.internal`,
which is not localhost — Ollama's default localhost-only bind would refuse it. Your model
fingerprint references must be captured from this exact setup (native Ollama version + quant);
re-capture with `scripts/capture-references.mjs` against `OLLAMA_URL=http://127.0.0.1:11434`.

## 2. Register onchain

Stake + publish endpoint, model digest, and price table (see `register.sh`).
You appear in the explorer within ~2 minutes of your first heartbeat.

## 3. Earn

The host share of each settled request accumulates in the vault. Withdraw it
to your host wallet with the console or `tor-host withdraw`.
Price competitively: the gateway scores cheapest-fastest-staked-reliable first.
Pause anytime without unstaking. Deregistration starts the separate stake
release timelock.
