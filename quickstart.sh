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
# menu_pick "line1\nline2\n…" DEFAULT — arrow-key menu on /dev/tty (↑↓ + Enter,
# 1-9 jumps), numbered fallback when no tty. Echoes the 1-based index.
menu_pick() {
  _mp_list=$1; _mp_i=${2:-1}
  _mp_n=$(printf '%s\n' "$_mp_list" | grep -c .)
  # A usable console = /dev/tty opens AND answers stty (containers have a
  # dead /dev/tty node that opens but blocks forever — never trust -r alone).
  if (exec 3<>/dev/tty && stty -g <&3 >/dev/null 2>&1) 2>/dev/null; then
    : # usable console below
  else
    printf "  pick [1-%s, default %s]: " "$_mp_n" "$_mp_i"
    IFS= read -r _mp_val 2>/dev/null || _mp_val=""
    echo "${_mp_val:-$_mp_i}"
    return 0
  fi
  _mp_old=$(stty -g < /dev/tty 2>/dev/null || echo "")
  _mp_cleanup() {
    stty "$_mp_old" < /dev/tty 2>/dev/null || stty sane < /dev/tty 2>/dev/null || true
    printf '\033[?25h' > /dev/tty 2>/dev/null || true
  }
  trap _mp_cleanup INT TERM
  printf '\033[?25l' > /dev/tty 2>/dev/null || true
  stty -icanon -echo < /dev/tty 2>/dev/null || true
  _mp_k=1
  while [ "$_mp_k" -le "$_mp_n" ]; do printf '\n' > /dev/tty; _mp_k=$((_mp_k + 1)); done
  while :; do
    printf '\033[%sA' "$_mp_n" > /dev/tty 2>/dev/null || true
    _mp_k=1
    while [ "$_mp_k" -le "$_mp_n" ]; do
      _mp_line=$(printf '%s\n' "$_mp_list" | sed -n "${_mp_k}p")
      if [ "$_mp_k" -eq "$_mp_i" ]; then
        printf '\r\033[K  ${B}>${RST} %s\n' "$_mp_line" > /dev/tty
      else
        printf '\r\033[K    %s\n' "$_mp_line" > /dev/tty
      fi
      _mp_k=$((_mp_k + 1))
    done
    _mp_key=$(dd bs=1 count=1 < /dev/tty 2>/dev/null)
    if [ "$_mp_key" = "$(printf '\033')" ]; then
      _mp_seq=$(dd bs=2 count=1 < /dev/tty 2>/dev/null)
      case "$_mp_seq" in
        "[A") _mp_i=$((_mp_i - 1)); [ "$_mp_i" -lt 1 ] && _mp_i=$_mp_n;;
        "[B") _mp_i=$((_mp_i + 1)); [ "$_mp_i" -gt "$_mp_n" ] && _mp_i=1;;
      esac
    elif [ -z "$_mp_key" ]; then
      break # Enter (newline) — accept highlighted
    else
      case "$_mp_key" in
        [1-9]) [ "$_mp_key" -le "$_mp_n" ] && { _mp_i=$_mp_key; break; };;
      esac
    fi
  done
  _mp_cleanup
  trap - INT TERM
  echo "$_mp_i"
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
if [ -n "${MODEL_ID:-}" ]; then
  ok "serving $MODEL_ID (pinned via env)"
else
  # pass 1 (silent): recommended default = biggest fitting in half the RAM.
  n=0; def_n=1
  while IFS='|' read -r id size min blurb; do
    [ -n "$id" ] || continue
    n=$((n + 1))
    if awk "BEGIN{exit !( $size <= $RAM_GB * 0.5 )}"; then def_n=$n; fi
  done <<EOF
$MODELS
EOF
  # pass 2: display rows — exactly one ★, on the default.
  rows=""; n=0
  while IFS='|' read -r id size min blurb; do
    [ -n "$id" ] || continue
    n=$((n + 1))
    if [ "$RAM_GB" -ge "$min" ]; then fit="${GRN}✓ fits${RST}"; else fit="${RED}✗ tight${RST}"; fi
    if [ "$n" -eq "$def_n" ]; then star=" ${YLW}★${RST}"; else star=""; fi
    # shellcheck disable=SC2059
    rows="$rows$(printf '%-14s %4sGB · needs %sGB+  %b%s %s' "$id" "$size" "$min" "$fit" "$star" "$blurb")
"
  done <<EOF
$MODELS
EOF
  rows=$(printf '%s' "$rows" | sed -e '$ { /^$/ d; }')
  hint "↑↓ to move · Enter to select · 1-6 to jump"
  PICK=$(menu_pick "$rows" "$def_n")
  MODEL_ID=$(printf '%s\n' "$MODELS" | sed -n "${PICK:-$def_n}p" | cut -d'|' -f1)
  [ -n "$MODEL_ID" ] || MODEL_ID="qwen2.5:0.5b"
  ok "serving $MODEL_ID"
fi

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
    hint "creating the keychain entry now (type a fresh password twice — I never see it):"
    if security add-generic-password -a default -s ledger-wallet-cli -w < /dev/tty > /dev/tty 2>&1; then
      ok "password stored in your keychain"
    else
      hint "that failed — run it yourself once, then continue:"
      cmd "security add-generic-password -a default -s ledger-wallet-cli -w"
      pause "Stored? Continue…"
    fi
  fi
  warn "provisioning ring — approve ONCE on the device…"
  WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init \
    && ok "ring live — your host key and taps are device-backed" \
    || hint "(see LEDGER-WALKTHROUGH step 2 if that failed)"
else
  hint "skipped (no wallet-cli)"
fi

step "6/7" "your account (one login, one click)"
hint "opening onboarding — log in, subscribe \$10, come back…"
(open http://localhost:3002/onboarding 2>/dev/null || xdg-open http://localhost:3002/onboarding 2>/dev/null || true)
pause "Logged in and subscribed? Continue…"
if have tor-host; then
  hint "linking this machine — the approval page opens by itself, one click…"
  if tor-host login < /dev/tty > /dev/tty 2>&1; then
    if tor-host link 2>/dev/null; then
      ok "linked — dashboard live at http://localhost:3002/host/dashboard"
      (open http://localhost:3002/host/dashboard 2>/dev/null || xdg-open http://localhost:3002/host/dashboard 2>/dev/null || true)
    else
      # link needs a registered host (tor-host run); localhost-only setups
      # don't have one yet. Account login still done — link completes at step 7.
      ok "logged in — no host registered yet, so nothing to claim (dashboard shows your account)"
      hint "go public at step 7 and the claim runs automatically"
    fi
  else
    warn "login skipped — run later: tor-host login"
  fi
else
  warn "tor-host not on PATH — run later: tor-host login"
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
