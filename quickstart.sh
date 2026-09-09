#!/bin/sh
# TrulyOpenRouter quickstart: one script, localhost, ~15 minutes.
# Installs the CLI, starts the stack, and walks you through Ledger + Privy.
# Usage: sh quickstart.sh
# Nothing here costs money (testnet + faucet funds only).
set -eu
cd "$(dirname "$0")"

# --- style: Codex-like minimal. Colors auto-off when piped. ------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); GRN=$(printf '\033[32m')
  YLW=$(printf '\033[33m'); RED=$(printf '\033[31m'); CYN=$(printf '\033[36m')
  RST=$(printf '\033[0m');
else
  B=""; DIM=""; GRN=""; YLW=""; RED=""; CYN=""; RST="";
fi
step() { printf "\n${B}◆ %s${RST} ${DIM}%s${RST}\n" "$1" "$2"; }  # step "1/6" "CLI (tor-host)"
ok() { printf "  ${GRN}✓${RST} %s\n" "$1"; }
warn() { printf "  ${YLW}!${RST} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RST} %s\n" "$1"; }
hint() { printf "  ${DIM}%s${RST}\n" "$1"; }
cmd() { printf "  ${CYN}%s${RST}\n" "$1"; }
die() { fail "$1"; exit 1; }
pause() { printf "\n  %s ${DIM}[Enter]${RST} " "$1"; IFS= read -r _ < /dev/tty 2>/dev/null || true; }
have() { command -v "$1" >/dev/null 2>&1; }

printf "\n"
printf "${B}╭────────────────────────────────────────╮${RST}\n"
printf "${B}│  TrulyOpenRouter — quickstart          │${RST}\n"
printf "${DIM}│  localhost · ~15 min · testnet, free   │${RST}\n"
printf "${B}╰────────────────────────────────────────╯${RST}\n"

step "0/6" "dependencies"
miss=0
for t in node npm docker cast; do
  if have "$t"; then ok "$t"; else fail "$t — missing"; miss=1; fi
done
[ "$miss" = 0 ] || die "install the missing tools above, then re-run"
have wallet-cli || hint "(optional) Ledger CLI: npm i -g @ledgerhq/wallet-cli"

step "1/6" "CLI (tor-host)"
(cd host-runner/cli && npm install --no-audit --no-fund >/dev/null 2>&1 || true && npm run build >/dev/null 2>&1 || true)
if have tor-host; then ok "tor-host already on PATH"; else
  warn "linking tor-host (may ask for sudo)…"
  (cd host-runner/cli && (npm link 2>/dev/null || sudo npm link)) || hint "link failed — use: npx --prefix host-runner/cli tsx src/index.ts"
fi
have tor-host && ok "tor-host on PATH" || warn "tor-host not on PATH yet — open a new terminal"

step "2/6" "stack (ollama + guard)"
for p in 11434 4122; do
  if curl -sf -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null || (echo > "/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    die "port $p is busy — stop whatever holds it first (try: lsof -i :$p), then re-run"
  fi
done
docker compose -f host-runner/docker-compose.yml up -d ollama guard
docker exec "$(docker ps -q --filter ancestor=ollama/ollama | head -1)" ollama pull qwen2.5:0.5b
ok "guard :4122, model pulled"

step "3/6" "gateway + web (dev mode, no chain)"
hint "open TWO more terminals and run:"
cmd "cd gateway && PORT=4121 UPSTREAM_URL=http://127.0.0.1:11434 \\"
cmd "  HOSTS_JSON='[{\"endpoint\":\"http://127.0.0.1:4122\",\"modelId\":\"qwen2.5:0.5b\"}]' npx tsx src/index.ts"
cmd "npm run dev --prefix web   # :3002"
pause "Start those two, then continue…"
curl -sf http://127.0.0.1:4121/health >/dev/null && ok "gateway :4121" || die "gateway not up — start it, then re-run from step 3"

step "4/6" "Ledger (optional, ~5 min — device + one tap)"
if have wallet-cli; then
  wallet-cli genuine-check || hint "(plug in, unlock, dashboard — then continue)"
  pause "Device genuine? Continue…"
  if security find-generic-password -a default -s ledger-wallet-cli >/dev/null 2>&1; then
    ok "ring password already in keychain"
  else
    hint "run this once (type a fresh password twice, I never see it):"
    cmd "security add-generic-password -a default -s ledger-wallet-cli -w"
    pause "Stored? Continue…"
  fi
  warn "provisioning ring — approve ONCE on the device…"
  WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init \
    && ok "ring live (needs Ledger Sync app+enabled first — see .local/LEDGER-WALKTHROUGH.md if it errors)" \
    || hint "(see LEDGER-WALKTHROUGH step 2 if that failed)"
else
  hint "skipped (no wallet-cli) — install it later, nothing else depends on it"
fi

step "5/6" "Privy (login + subscribe, ~3 min)"
hint "opening the onboarding…"
(open http://localhost:3002/onboarding 2>/dev/null || xdg-open http://localhost:3002/onboarding 2>/dev/null || true)
hint "1. Log in (email OTP)  2. Fund hint shows your address  3. Subscribe \$10"
pause "Subscribed (credits show 10000)? Continue…"

step "6/6" "serve (become a host, optional)"
hint "one command does it all (key stays on your machine):"
cmd "sh host-runner/setup.sh"
hint "full manual walkthrough: SELF-HOST.md"

printf "\n${B}╭────────────────────────────────────────╮${RST}\n"
printf "${B}│  ${GRN}✓${B} ready — happy hosting                 │${RST}\n"
printf "${B}╰────────────────────────────────────────╯${RST}\n"
hint "chat at http://localhost:3002/chat · network at /network"
hint "team pools at /team · tap queue at /security · checklist: .local/TEST-LIST.md"
