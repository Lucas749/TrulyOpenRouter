# Host runner — serve a model on TrulyOpenRouter

Anyone with a GPU (or a Mac with Ollama) can join. Three steps, minutes.

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

90% of every routed call lands in the host wallet as withdrawable earnings.
Price competitively: the gateway scores cheapest-fastest-staked-reliable first.
Pause anytime; unstake unlocks after the timelock (Ledger-tapped release).
