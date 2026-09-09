#!/bin/sh
# TrulyOpenRouter quickstart: one command in, live dashboard out. Localhost, ~15 min.
# Detects your hardware, lets you pick a model, starts everything (gateway + web
# run themselves — no extra terminals), walks you through Ledger, links your
# account, and optionally registers you as a public host.
# Usage: sh quickstart.sh [--stop]   (MODEL_ID=… env pins the model, non-interactive)
# Nothing here costs money (testnet + faucet funds only).
set -eu
cd "$(dirname "$0")"

if [ "${1:-}" = "--stop" ] || [ "${1:-}" = "stop" ]; then
  for s in gateway web; do
    if [ -f ".local/qs-$s.pid" ]; then
      kill "$(cat ".local/qs-$s.pid")" 2>/dev/null && echo "stopped $s" || echo "$s already down"
      rm -f ".local/qs-$s.pid"
    fi
  done
  docker compose -f host-runner/docker-compose.yml down 2>/dev/null || true
  echo "stack down — re-run sh quickstart.sh anytime"
  exit 0
fi

# --- style: Codex-like minimal. Colors auto-off when piped. ------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); GRN=$(printf '\033[32m')
  YLW=$(printf '\033[33m'); RED=$(printf '\033[31m'); CYN=$(printf '\033[36m')
  RST=$(printf '\033[0m');
else
  B=""; DIM=""; GRN=""; YLW=""; RED=""; CYN=""; RST="";
fi
step() { printf "\n${B}◆ %s${RST} ${DIM}%s${RST}\n" "$1" "$2"; }
ok() { printf "  ${GRN}✓${RST} %s\n" "$1"; }
warn() { printf "  ${YLW}!${RST} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RST} %s\n" "$1"; }
hint() { printf "  ${DIM}%s${RST}\n" "$1"; }
cmd() { printf "  ${CYN}%s${RST}\n" "$1"; }
die() { fail "$1"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
pause() { printf "\n  %s ${DIM}[Enter]${RST} " "$1"; IFS= read -r _ < /dev/tty 2>/dev/null || true; }
# ask_tty VAR PROMPT DEFAULT — env wins, else /dev/tty (curl|bash safe), else default.
ask_tty() {
  eval "cur=\${$1:-}"
  if [ -n "$cur" ]; then return 0; fi
  if [ -c /dev/tty ] 2>/dev/null || [ -e /dev/tty ]; then
    printf "  %s ${DIM}[%s]${RST}: " "$2" "$3" > /dev/tty
    IFS= read -r val < /dev/tty 2>/dev/null || val=""
    eval "$1=\${val:-$3}"
  else
    eval "$1=\$3"
  fi
}
# wait_for NAME URL SECONDS — dots until curl 200s.
wait_for() {
  printf "  waiting for %s" "$1"
  i=0
  while [ "$i" -lt "$3" ]; do
    if curl -sf -o /dev/null "$2" 2>/dev/null; then printf "\n"; ok "$1 up"; return 0; fi
    printf "."; sleep 2; i=$((i + 2))
  done
  printf "\n"; return 1
}

printf "\n"
printf "${B}╭────────────────────────────────────────╮${RST}\n"
printf "${B}│  TrulyOpenRouter — quickstart          │${RST}\n"
printf "${DIM}│  localhost · ~15 min · testnet, free   │${RST}\n"
printf "${B}╰────────────────────────────────────────╯${RST}\n"

step "0/7" "dependencies"
miss=0
for t in node npm docker cast; do
  if have "$t"; then ok "$t"; else fail "$t — missing"; miss=1; fi
done
[ "$miss" = 0 ] || die "install the missing tools above, then re-run"

step "1/7" "CLI (tor-host)"
(cd host-runner/cli && npm install --no-audit --no-fund >/dev/null 2>&1 || true && npm run build >/dev/null 2>&1 || true)
if have tor-host; then ok "tor-host already on PATH"; else
  warn "linking tor-host (may ask for sudo)…"
  (cd host-runner/cli && (npm link 2>/dev/null || sudo npm link)) || hint "link failed — use: npx --prefix host-runner/cli tsx src/index.ts"
fi
have tor-host && ok "tor-host on PATH" || warn "tor-host not on PATH yet — open a new terminal"

step "2/7" "your hardware → pick a model"
OS=$(uname -s)
if [ "$OS" = "Darwin" ]; then
  RAM_GB=$(( $(sysctl -n hw.memsize) / 1000000000 ))
  CPU_N=$(sysctl -n hw.ncpu)
  CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
  case "$CHIP" in *Apple*|*M1*|*M2*|*M3*|*M4*) GPU="Apple Silicon (unified memory — great for local models)";; *) GPU="$CHIP";; esac
else
  RAM_GB=$(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo 2>/dev/null || echo 8)
  CPU_N=$(nproc 2>/dev/null || echo 4)
  GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "no discrete GPU (CPU inference)")
fi
DISK_FREE=$(df -m "$HOME" 2>/dev/null | awk 'NR==2 {print int($4/1024)}' || echo "?")
printf "  ${B}%s${RST} · ${B}%sGB RAM${RST} · %s cpu · %sGB free · %s\n" "$OS" "$RAM_GB" "$CPU_N" "$DISK_FREE" "$GPU"
# catalog: id|sizeGB|minRAM|blurb
MODELS="qwen2.5:0.5b|0.4|2|tiny · instant · best for testing
qwen2.5:1.5b|1.0|4|small · quick answers
llama3.2:3b|2.0|8|balanced daily driver
qwen2.5:7b|4.7|8|capable · wants room
llama3.1:8b|4.9|16|strong · 16GB+
deepseek-r1:8b|5.2|16|reasoning · slower"
mkdir -p .local
: > .local/qs-models.tmp
n=0; def_n=1
# heredoc loop (not a pipe) so def_n survives — pipes fork subshells.
while IFS='|' read -r id size min blurb; do
  [ -n "$id" ] || continue
  n=$((n + 1))
  if [ "$RAM_GB" -ge "$min" ]; then fit="${GRN}✓ fits${RST}"; else fit="${RED}✗ tight${RST}"; fi
  if awk "BEGIN{exit !( $size <= $RAM_GB * 0.5 )}"; then def_n=$n; star="${YLW}★ pick${RST}"; else star=""; fi
  # shellcheck disable=SC2059
  printf "  ${B}%s)${RST} %-14s ${DIM}%4sGB · needs %sGB+${RST}  %b %s %s\n" "$n" "$id" "$size" "$min" "$fit" "$star" "$blurb"
  echo "$n=$id" >> .local/qs-models.tmp
done <<EOF
$MODELS
EOF
ask_tty PICK "Which model do you want to run?" "$def_n"
MODEL_ID="${MODEL_ID:-$(awk -F= -v p="$PICK" '$1==p {print $2}' .local/qs-models.tmp)}"
[ -n "$MODEL_ID" ] || MODEL_ID="qwen2.5:0.5b"
rm -f .local/qs-models.tmp
ok "serving $MODEL_ID"

step "3/7" "stack (ollama + guard)"
if docker ps -q --filter ancestor=ollama/ollama 2>/dev/null | grep -q .; then
  ok "stack already up from a previous run, reusing"
else
  for p in 11434 4122; do
    if curl -sf -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null || (echo > "/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      die "port $p is busy — stop whatever holds it first (try: lsof -i :$p), then re-run"
    fi
  done
  docker compose -f host-runner/docker-compose.yml up -d ollama guard
fi
warn "pulling $MODEL_ID (one-time download, a few minutes)…"
docker exec "$(docker ps -q --filter ancestor=ollama/ollama | head -1)" ollama pull "$MODEL_ID"
ok "guard :4122 · $MODEL_ID ready"

step "4/7" "gateway + web (starting them for you)"
mkdir -p .local
(cd gateway && nohup env PORT=4121 UPSTREAM_URL=http://127.0.0.1:11434 \
  HOSTS_JSON="[{\"endpoint\":\"http://127.0.0.1:4122\",\"modelId\":\"$MODEL_ID\"}]" \
  npx tsx src/index.ts > ../.local/qs-gateway.log 2>&1 & echo $! > ../.local/qs-gateway.pid)
(cd web && nohup env PORT=3002 npm run dev > ../.local/qs-web.log 2>&1 & echo $! > ../.local/qs-web.pid)
wait_for "gateway :4121" "http://127.0.0.1:4121/health" 60 || die "gateway never came up — see .local/qs-gateway.log, then re-run"
wait_for "web :3002" "http://127.0.0.1:3002/" 120 || die "web never came up — see .local/qs-web.log, then re-run"
hint "logs: .local/qs-gateway.log · .local/qs-web.log · stop all: sh quickstart.sh --stop"

step "5/7" "Ledger (security + redeem — do this now, it protects everything below)"
if ! have wallet-cli; then
  ask_tty INSTALL_WC "Install the Ledger CLI now?" "Y"
  case "$INSTALL_WC" in Y|y|"") (npm i -g @ledgerhq/wallet-cli 2>/dev/null || sudo npm i -g @ledgerhq/wallet-cli) && ok "wallet-cli installed" || warn "install failed — run: npm i -g @ledgerhq/wallet-cli";; *) hint "skipped — security steps below stay optional";; esac
fi
if have wallet-cli; then
  wallet-cli genuine-check || hint "(plug in, unlock, open the dashboard app — then continue)"
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
    && ok "ring live — your host key and taps are device-backed" \
    || hint "(see LEDGER-WALKTHROUGH step 2 if that failed)"
else
  hint "skipped (no wallet-cli)"
fi

step "6/7" "your account (login → link → dashboard)"
hint "opening the login + link pages…"
(open http://localhost:3002/onboarding 2>/dev/null || xdg-open http://localhost:3002/onboarding 2>/dev/null || true)
(open http://localhost:3002/host/link 2>/dev/null || xdg-open http://localhost:3002/host/link 2>/dev/null || true)
hint "1. Log in (email OTP)  2. Fund hint shows your address  3. Subscribe \$10"
pause "Logged in and subscribed? Continue…"
if have tor-host; then
  hint "linking this machine to your account (approve the code at /host/link)…"
  if tor-host login < /dev/tty > /dev/tty 2>&1; then
    tor-host link && ok "linked — your dashboard is live" || warn "link later: tor-host login && tor-host link"
  else
    warn "login skipped — link later: tor-host login && tor-host link"
  fi
else
  warn "tor-host not on PATH — link later: tor-host login && tor-host link"
fi

step "7/7" "serve (optional — join the public network as a paid host)"
hint "localhost already works (chat below). Going public needs a reachable"
hint "endpoint + testnet HBAR for stake. One command does it all:"
ask_tty GO_PUBLIC "Register as a public host now?" "n"
case "$GO_PUBLIC" in Y|y)
  hint "setup.sh asks for endpoint, Hedera id, host key, stake (testnet only)…"
  MODEL_ID="$MODEL_ID" sh host-runner/setup.sh < /dev/tty > /dev/tty 2>&1 || warn "setup exited — re-run: sh host-runner/setup.sh"
  ;;
*) hint "skipped — go public anytime: sh host-runner/setup.sh";;
esac

printf "\n${B}╭────────────────────────────────────────╮${RST}\n"
printf "${B}│  ${GRN}✓${B} TrulyOpenRouter is live               │${RST}\n"
printf "${B}╰────────────────────────────────────────╯${RST}\n"
printf "  chat       ${CYN}http://localhost:3002/chat${RST}\n"
printf "  dashboard  ${CYN}http://localhost:3002/host/dashboard${RST}\n"
printf "  model      ${B}%s${RST}\n" "$MODEL_ID"
printf "  stop       ${DIM}sh quickstart.sh --stop${RST}\n"
