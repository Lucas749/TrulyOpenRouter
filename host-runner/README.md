# Host runner — serve a model on TrulyOpenRouter

Anyone with a GPU (or a Mac with Ollama) can join. Three steps, minutes.

## 1. Run a model

```sh
docker compose up -d
ollama pull llama3.1:8b            # or qwen2.5:7b
```

CPU-only works for the registry join demo; GPUs serve real traffic.
`MODEL_DIGEST` = sha256 of `ollama show --modelfile <model>` output — pin it:

```sh
export MODEL_ID="llama-3.1-8b"
export MODEL_DIGEST="0x…"          # sha256 of the modelfile
export ENDPOINT="http://<your-ip>:11434"
```

## 2. Register onchain

Stake + publish endpoint, model digest, and price table (see `register.sh`).
You appear in the explorer within ~2 minutes of your first heartbeat.

## 3. Earn

90% of every routed call lands in the host wallet as withdrawable earnings.
Price competitively: the gateway scores cheapest-fastest-staked-reliable first.
Pause anytime; unstake unlocks after the timelock (Ledger-tapped release).
