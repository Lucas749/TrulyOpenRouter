#!/bin/sh
# TrulyOpenRouter quickstart: one script, localhost, ~15 minutes.
# Installs the CLI, starts the stack, and walks you through Ledger + Privy.
# Usage: sh quickstart.sh
# Nothing here costs money (testnet + faucet funds only).
set -eu
cd "$(dirname "$0")"

pause() { printf "\n%s [Enter] " "$1"; IFS=read -r _ || true; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "=== 0/6 deps ==="
miss=0
for t in node npm docker cast; do
  if have "$t"; then echo "  ok: $t"; else echo "  MISSING: $t"; miss=1; fi
done
[ "$miss" = 0 ] || { echo "install the missing tools above, then re-run"; exit 1; }
have wallet-cli || echo "  (optional) Ledger CLI: npm i -g @ledgerhq/wallet-cli"

echo ""
echo "=== 1/6 CLI (tor-host) ==="
(cd host-runner/cli && npm install --no-audit --no-fund >/dev/null 2>&1 || true && npm run build >/dev/null 2>&1 || true)
if have tor-host; then echo "  ok: tor-host already on PATH"; else
  echo "  linking tor-host (may ask for sudo)…"
  (cd host-runner/cli && (npm link 2>/dev/null || sudo npm link)) || echo "  link failed — use: npx --prefix host-runner/cli tsx src/index.ts"
fi
tor-host --help >/dev/null 2>&1 && echo "  ok: tor-host responds" || echo "  (tor-host not on PATH yet — open a new terminal)"

echo ""
echo "=== 2/6 stack (ollama + guard) ==="
docker compose -f host-runner/docker-compose.yml up -d ollama guard
docker exec "$(docker ps -q --filter ancestor=ollama/ollama | head -1)" ollama pull qwen2.5:0.5b
echo "  ok: guard :4122, model pulled"

echo ""
echo "=== 3/6 gateway + web (dev mode, no chain) ==="
echo "  open TWO more terminals and run:"
echo "    cd gateway && PORT=4121 UPSTREAM_URL=http://127.0.0.1:11434 \\"
echo "      HOSTS_JSON='[{\"endpoint\":\"http://127.0.0.1:4122\",\"modelId\":\"qwen2.5:0.5b\"}]' npx tsx src/index.ts"
echo "    npm run dev --prefix web   # :3002"
pause "Start those two, then continue…"
curl -sf http://127.0.0.1:4121/health >/dev/null && echo "  ok: gateway" || { echo "  gateway not up — start it, then re-run from step 3"; exit 1; }

echo ""
echo "=== 4/6 Ledger (optional, ~5 min — device + one tap) ==="
if have wallet-cli; then
  wallet-cli genuine-check || echo "  (plug in, unlock, dashboard — then continue)"
  pause "Device genuine? Continue…"
  if security find-generic-password -a default -s ledger-wallet-cli >/dev/null 2>&1; then
    echo "  ok: ring password already in keychain"
  else
    echo "  run this once (type a fresh password twice, I never see it):"
    echo "    security add-generic-password -a default -s ledger-wallet-cli -w"
    pause "Stored? Continue…"
  fi
  echo "  provisioning ring — approve ONCE on the device…"
  WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init \
    && echo "  ok: ring live (needs Ledger Sync app+enabled first — see .local/LEDGER-WALKTHROUGH.md if it errors)" \
    || echo "  (see LEDGER-WALKTHROUGH step 2 if that failed)"
else
  echo "  skipped (no wallet-cli) — install it later, nothing else depends on it"
fi

echo ""
echo "=== 5/6 Privy (login + subscribe, ~3 min) ==="
echo "  opening the onboarding…"
(open http://localhost:3002/onboarding 2>/dev/null || xdg-open http://localhost:3002/onboarding 2>/dev/null || true)
echo "  1. Log in (email OTP)  2. Fund hint shows your address  3. Subscribe \$10"
pause "Subscribed (credits show 10000)? Continue…"

echo ""
echo "=== 6/6 serve (become a host, optional) ==="
echo "  one command does it all (key stays on your machine):"
echo "    sh host-runner/setup.sh"
echo "  or click through it at http://localhost:3002/host/setup"
echo ""
echo "done — chat at http://localhost:3002/chat, network at /network,"
echo "team pools at /team, tap queue at /security. Full checklist: .local/TEST-LIST.md"
