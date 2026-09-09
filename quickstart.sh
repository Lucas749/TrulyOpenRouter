#!/bin/sh
# TrulyOpenRouter quickstart: one command in, serving host out. ~15 min.
# Your machine only ever runs the serving side (ollama + guard). The gateway,
# web, and chain are hosted — this script points your host at them, walks you
# through Ledger, links your account, and registers you on the network.
# Usage: sh quickstart.sh [--stop]   (MODEL_ID=… env pins the model, non-interactive)
# Nothing here costs money (testnet + faucet funds only).
set -eu
cd "$(dirname "$0")"

# Hosted backend. Override for dev (PROD_GW=http://127.0.0.1:4121 PROD_WEB=http://localhost:3002).
PROD_GW="${PROD_GW:-https://trulyopenrouter.vercel.app/api/gw}"
PROD_WEB="${PROD_WEB:-https://trulyopenrouter.vercel.app}"

if [ "${1:-}" = "--stop" ] || [ "${1:-}" = "stop" ]; then
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
# menu_pick "line1\nline2\n…" DEFAULT [TITLE] [SUB] — fullscreen picker on the
# alternate screen (Claude/Codex style: owns the display, updates in place, no
# scroll; ↑↓ + Enter, 1-9 jumps). Numbered fallback without a usable console.
# Echoes the 1-based index.
menu_pick() {
  _mp_list=$1; _mp_i=${2:-1}; _mp_title=${3:-pick}; _mp_sub=${4:-}
  _mp_n=$(printf '%s\n' "$_mp_list" | grep -c .)
  # A usable console = /dev/tty opens AND answers stty (containers have a
  # dead /dev/tty node that opens but blocks forever — never trust -r alone).
  if [ "${TERM:-dumb}" = "dumb" ] || ! (exec 3<>/dev/tty && stty -g <&3 >/dev/null 2>&1) 2>/dev/null; then
    printf "  pick [1-%s, default %s]: " "$_mp_n" "$_mp_i"
    IFS= read -r _mp_val 2>/dev/null || _mp_val=""
    echo "${_mp_val:-$_mp_i}"
    return 0
  fi
  _mp_old=$(stty -g < /dev/tty 2>/dev/null || echo "")
  _mp_cleanup() {
    printf '\033[?1049l\033[?25h' > /dev/tty 2>/dev/null || true
    stty "$_mp_old" < /dev/tty 2>/dev/null || stty sane < /dev/tty 2>/dev/null || true
  }
  trap _mp_cleanup INT TERM
  printf '\033[?1049h\033[?25l' > /dev/tty 2>/dev/null || true
  stty -icanon -echo < /dev/tty 2>/dev/null || true
  _mp_draw() {
    printf "\033[H\033[J\r\n  ${B}%s${RST}\r\n" "$_mp_title" > /dev/tty 2>/dev/null || true
    if [ -n "$_mp_sub" ]; then printf "  ${DIM}%s${RST}\r\n" "$_mp_sub" > /dev/tty 2>/dev/null || true; fi
    printf "\r\n" > /dev/tty 2>/dev/null || true
    _mp_k=1
    while [ "$_mp_k" -le "$_mp_n" ]; do
      _mp_line=$(printf '%s\n' "$_mp_list" | sed -n "${_mp_k}p")
      if [ "$_mp_k" -eq "$_mp_i" ]; then
        printf "  ${GRN}❯${RST} ${B}%s${RST}\r\n" "$_mp_line" > /dev/tty 2>/dev/null || true
      else
        printf "     %s\r\n" "$_mp_line" > /dev/tty 2>/dev/null || true
      fi
      _mp_k=$((_mp_k + 1))
    done
    printf "\r\n  ${DIM}↑↓ move · Enter select · 1-%s jump${RST}\r\n" "$_mp_n" > /dev/tty 2>/dev/null || true
  }
  while :; do
    _mp_draw
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
HW_SUM="$OS · $RAM_GB""GB RAM · $CPU_N cpu · ${DISK_FREE}GB free · $GPU"
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
    rows="$rows$(printf "${DIM}%s${RST} %-14s %4sGB · needs %sGB+  %b%s %s" "$n" "$id" "$size" "$min" "$fit" "$star" "$blurb")
"
  done <<EOF
$MODELS
EOF
  rows=$(printf '%s' "$rows" | sed -e '$ { /^$/ d; }')
  PICK=$(menu_pick "$rows" "$def_n" "pick a model" "$HW_SUM")
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

step "4/7" "hosted backend (nothing to run — just checking it's reachable)"
wait_for "gateway $PROD_GW" "$PROD_GW/health" 60 || die "hosted gateway unreachable — check your net, then re-run"
wait_for "web $PROD_WEB" "$PROD_WEB/" 60 || die "hosted web unreachable — check your net, then re-run"
hint "gateway + web + chain are hosted; your machine only serves models"

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
(open "$PROD_WEB/onboarding" 2>/dev/null || xdg-open "$PROD_WEB/onboarding" 2>/dev/null || true)
pause "Logged in and subscribed? Continue…"
if have tor-host; then
  hint "linking this machine — the approval page opens by itself, one click…"
  if tor-host login --gateway="$PROD_GW" < /dev/tty > /dev/tty 2>&1; then
    ok "logged in — the claim runs automatically once your host registers below"
  else
    warn "login skipped — run later: tor-host login --gateway=$PROD_GW"
  fi
else
  warn "tor-host not on PATH — run later: tor-host login --gateway=$PROD_GW"
fi

step "7/7" "serve (register on the network, earn per request)"
hint "this generates your host key, registers onchain (testnet stake),"
hint "starts serving $MODEL_ID, and claims the host for your account."
hint "the network must reach your guard — LAN won't route, so either expose"
hint ":4122 (ngrok / cloudflared / public IP) or serve LAN-only for now."
ask_tty ENDPOINT "Your guard's public URL (empty = http://<lan-ip>:4122, LAN-only)" ""
if [ -z "$ENDPOINT" ]; then
  hint "LAN-only: you serve, but the public network can't route to you yet."
  hint "re-run with a tunnel URL anytime: tor-host run --endpoint https://… --model $MODEL_ID"
fi
if tor-host run --gateway="$PROD_GW" --model "$MODEL_ID" ${ENDPOINT:+--endpoint="$ENDPOINT"} < /dev/tty > /dev/tty 2>&1; then
  ok "serving $MODEL_ID on the network — dashboard live at $PROD_WEB/host/dashboard"
  (open "$PROD_WEB/host/dashboard" 2>/dev/null || xdg-open "$PROD_WEB/host/dashboard" 2>/dev/null || true)
else
  warn "run exited (underfunded host key is the usual cause — it prints the faucet address)"
  hint "fund it, then re-run just this step:"
  cmd "tor-host run --gateway=$PROD_GW --model $MODEL_ID ${ENDPOINT:+--endpoint=$ENDPOINT}"
fi

printf "\n${B}╭────────────────────────────────────────╮${RST}\n"
printf "${B}│  ${GRN}✓${B} TrulyOpenRouter is live               │${RST}\n"
printf "${B}╰────────────────────────────────────────╯${RST}\n"
printf "  dashboard  ${CYN}%s/host/dashboard${RST}\n" "$PROD_WEB"
printf "  model      ${B}%s${RST}\n" "$MODEL_ID"
printf "  status     ${DIM}tor-host status${RST}\n"
printf "  stop       ${DIM}sh quickstart.sh --stop${RST}\n"
