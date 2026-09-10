#!/bin/sh
# One-shot host setup: pull model -> start stack -> register onchain -> heartbeat cron.
# Usage: sh host-runner/setup.sh [--dry-run]
# Prompts for what it can't know (host key, public endpoint). Everything else has sane defaults.
# Your HOST_KEY never leaves this machine (used only for local cast sends).
set -eu
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@"; fi }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 (install it first)"; exit 1; }; }
need docker; need cast

ask() { # ask VAR PROMPT DEFAULT (env overrides, so CI/scripted runs never block)
  eval "cur=\${$1:-}"
  if [ -n "$cur" ]; then return 0; fi
  printf "%s [%s]: " "$2" "$3"
  IFS= read -r val || true
  eval "$1=\${val:-$3}"
}
ask_secret() {
  eval "cur=\${$1:-}"
  if [ -n "$cur" ]; then return 0; fi
  printf "%s: " "$2"
  stty -echo 2>/dev/null || true
  IFS= read -r val || true
  stty echo 2>/dev/null || true
  echo ""
  [ -n "$val" ] || { echo "empty — aborting"; exit 1; }
  eval "$1=\$val"
}

REGISTRY="${REGISTRY:-0x5f83c19413fc15181e2e79512947e374c7b8dc56}"
RPC_URL="${RPC_URL:-https://testnet.hashio.io/api}"
ask MODEL_ID "Model to serve" "qwen2.5:0.5b"
ask ENDPOINT "Public endpoint of YOUR guard (https://… — LAN ips won't route)" ""
[ -n "$ENDPOINT" ] || { echo "ENDPOINT is required (your public guard URL)"; exit 1; }
ask HOST_HEDERA_ID "Your Hedera account id (0.0.…, receives USDC)" ""
[ -n "$HOST_HEDERA_ID" ] || { echo "HOST_HEDERA_ID is required"; exit 1; }
ask_secret HOST_KEY "Your host ECDSA private key (0x…, testnet only)"
ask STAKE_HBAR "Stake in HBAR (min 4; keep 1 HBAR for gas)" "4"
ask PRICE_PER_REQ "Price per req, delivered units (100000 = 1 credit)" "100000"
ask PRICE_PER_1K "Price per 1k tokens, delivered units" "100000"

if [ "$DRY" = 1 ]; then
  HOST_EVM="0xDRYRUN"
else
  HOST_EVM=$(cast wallet address --private-key "$HOST_KEY" 2>/dev/null)
fi
echo "host evm: $HOST_EVM"

echo "==> starting ollama + guard"
run docker compose -f host-runner/docker-compose.yml up -d ollama guard
echo "==> pulling $MODEL_ID"
run docker exec "$(docker ps -q --filter ancestor=ollama/ollama | head -1)" ollama pull "$MODEL_ID"

echo "==> model digest (proves what you serve; spot-checked)"
if [ "$DRY" = 1 ]; then
  echo "would run: ollama show --modelfile + sha256"
  MODEL_DIGEST="0xDRYRUN"
else
  MODEL_DIGEST="0x$(docker exec "$(docker ps -q --filter ancestor=ollama/ollama | head -1)" ollama show --modelfile "$MODEL_ID" | sha256sum | cut -d' ' -f1)"
fi
echo "digest: $MODEL_DIGEST"

echo "==> registering onchain (stakes $STAKE_HBAR HBAR)"
STAKE_WEI=$(python3 -c "print(int($STAKE_HBAR * 10**8) * 10**10)")
run env REGISTRY="$REGISTRY" RPC_URL="$RPC_URL" HOST_KEY="$HOST_KEY" ENDPOINT="$ENDPOINT" \
  MODEL_ID="$MODEL_ID" MODEL_DIGEST="$MODEL_DIGEST" PRICE_PER_REQ_WEI="$PRICE_PER_REQ" \
  PRICE_PER_1K_WEI="$PRICE_PER_1K" STAKE_WEI="$STAKE_WEI" sh host-runner/register.sh

echo "==> verifying"
run cast call "$REGISTRY" "getHost(address)(string,string,bytes32,uint256,uint256,bool,uint64)" "$HOST_EVM" --rpc-url "$RPC_URL"

echo "==> heartbeat every 10 min (keeps you in rotation; key stays in YOUR crontab)"
CRON="*/10 * * * * cast send $REGISTRY \"heartbeat()\" --rpc-url $RPC_URL --private-key $HOST_KEY >/dev/null 2>&1"
if [ "$DRY" = 1 ]; then
  echo "would install cron: $CRON"
else
  printf "Install it? [Y/n]: "
  IFS= read -r yn || true
  if [ "${yn:-Y}" != "n" ] && [ "${yn:-Y}" != "N" ]; then
    (crontab -l 2>/dev/null | grep -v "heartbeat()" || true; echo "$CRON") | crontab -
    echo "cron installed"
  else
    echo "skipped — run this yourself or you'll drop out of rotation:"
    echo "  $CRON"
  fi
fi

echo ""
echo "==> account link (every host needs one: login links this host to your dashboard)"
if command -v tor-host >/dev/null 2>&1; then
  if [ "$DRY" = 1 ]; then
    echo "would run: tor-host login (approve at /host/link) && tor-host link"
  else
    echo "This shows a code: approve it at /host/link while logged in (Privy email login)."
    if tor-host login; then
      tor-host link && echo "linked ✓ see it at /host/dashboard (any browser, once logged in)"
    else
      echo "login skipped — link later with: tor-host login && tor-host link"
    fi
  fi
else
  echo "install the CLI first (sh quickstart.sh step 1), then: tor-host login && tor-host link"
fi

echo ""
echo "done — you're serving. Track earnings at /host/dashboard, leave anytime with: tor-host leave"
