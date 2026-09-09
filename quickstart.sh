#!/bin/sh
# TrulyOpenRouter quickstart: one command in, serving host out. ~15 min.
# A fullscreen TUI app (own screen, live status board, nothing scrolls).
# Without a console it degrades to plain sequential output.
# Your machine only runs the serving side (ollama + guard). Gateway, web and
# chain are hosted — this points your host at them, walks you through Ledger,
# links your account, and registers you on the network.
# Usage: sh quickstart.sh [--stop]   (MODEL_ID=… env pins the model)
# Nothing here costs money (testnet + faucet funds only).
set -eu
cd "$(dirname "$0")"

PROD_GW="${PROD_GW:-https://trulyopenrouter.vercel.app/api/gw}"
PROD_WEB="${PROD_WEB:-https://trulyopenrouter.vercel.app}"
QS_SESS=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo "session")
# Brand mark (TOR block glyphs — widths verified 19 cols, keep aligned).
QS_MARK="█████   ███   ████
  █    █   █  █   █
  █    █   █  ████
  █    █   █  █ █
  █     ███   █  █"

if [ "${1:-}" = "--stop" ] || [ "${1:-}" = "stop" ]; then
  [ -f .local/qs-tunnel.pid ] && kill "$(cat .local/qs-tunnel.pid)" 2>/dev/null && echo "tunnel down" || true
  rm -f .local/qs-tunnel.pid
  docker compose -f host-runner/docker-compose.yml down 2>/dev/null || true
  echo "stack down — re-run sh quickstart.sh anytime"
  exit 0
fi

# --- style ------------------------------------------------------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); GRN=$(printf '\033[32m')
  YLW=$(printf '\033[33m'); RED=$(printf '\033[31m'); CYN=$(printf '\033[36m')
  RST=$(printf '\033[0m');
else
  B=""; DIM=""; GRN=""; YLW=""; RED=""; CYN=""; RST="";
fi
# Fullscreen app iff we own a real console (stty answers — dead /dev/tty
# nodes in containers open but block forever, never trust -r alone).
TUI=0
if [ "${TERM:-dumb}" != "dumb" ] && (exec 3<>/dev/tty && stty -g <&3 >/dev/null 2>&1) 2>/dev/null; then TUI=1; fi
title() {
  case $1 in
    0) echo "dependencies";; 1) echo "CLI (tor-host)";;
    2) echo "pick a model";; 3) echo "stack (ollama + guard)";;
    4) echo "hosted backend";; 5) echo "Ledger";; 6) echo "your account";;
    7) echo "serve";; *) echo "?";;
  esac
}

if [ "$TUI" = 1 ]; then
  # --- fullscreen app state -------------------------------------------------
  i=0; while [ "$i" -le 7 ]; do eval "ST_S_$i=todo; ST_M_$i=waiting"; i=$((i + 1)); done
  UI_BODY=""; UI_LOG=0; UI_FOOT=""; SPIN_N=0
  export TOR_ALT=1 # nested pickers draw on our screen, not their own
  tui_enter() {
    printf '\033[?1049h\033[?25l' > /dev/tty 2>/dev/null || true
  }
  tui_leave() {
    printf '\033[?1049l\033[?25h' > /dev/tty 2>/dev/null || true
    stty sane < /dev/tty 2>/dev/null || true
  }
  trap 'tui_leave; trap - INT TERM; exit 130' INT TERM
  spin_f() {
    case $((SPIN_N % 10)) in
      0) echo "⠋";; 1) echo "⠙";; 2) echo "⠹";; 3) echo "⠸";; 4) echo "⠼";;
      5) echo "⠴";; 6) echo "⠦";; 7) echo "⠧";; 8) echo "⠇";; *) echo "⠏";;
    esac
  }
  render() {
    {
      printf '\033[H\033[J'
      printf '%s\n' "$QS_MARK" | sed 's/^/  /' | while IFS= read -r _ml; do printf '  %s%s%s\r\n' "$B" "$_ml" "$RST"; done
      printf '  %sTrulyOpenRouter%s %squickstart%s\r\n' "$B" "$RST" "$DIM" "$RST"
      printf '  %sSession %s · testnet, free%s\r\n\r\n' "$DIM" "$QS_SESS" "$RST"
      _ri=0
      while [ "$_ri" -le 7 ]; do
        eval "_rs=\$ST_S_$_ri; _rm=\$ST_M_$_ri"
        case "$_rs" in
          ok) _ic="${GRN}✓${RST}";;
          run) _ic="${YLW}$(spin_f)${RST}";;
          fail) _ic="${RED}✗${RST}";;
          skip) _ic="${DIM}○${RST}";;
          *) _ic="${DIM}·${RST}";;
        esac
        printf '  %b %s/%s %s  %s%s%s\r\n' "$_ic" "$_ri" "7" "$(title "$_ri")" "$DIM" "$_rm" "$RST"
        _ri=$((_ri + 1))
      done
      printf '\r\n  %s────────────────────────────────────────%s\r\n' "$DIM" "$RST"
      if [ "$UI_LOG" = 1 ] && [ -f .local/qs-step.log ]; then
        tr '\r' '\n' < .local/qs-step.log 2>/dev/null | tail -5 | tr -d '\000-\010\013\014\016-\037\177' | sed 's/^/  /'
      elif [ -n "$UI_BODY" ]; then
        printf '%b' "$UI_BODY"
      fi
      if [ -n "$UI_FOOT" ]; then printf '\r\n  %s%s%s\r\n' "$DIM" "$UI_FOOT" "$RST"; fi
    } > /dev/tty 2>/dev/null || true
  }
  st_set() { eval "ST_S_$1=\"$2\"; ST_M_$1=\"$3\""; SPIN_N=$((SPIN_N + 1)); render; }
  st_state() { eval "echo \$ST_S_$1"; }
  step() { CUR=$1; st_set "$1" run "$2"; UI_BODY=""; UI_LOG=0; UI_FOOT=""; render; }
  ok() { st_set "$CUR" ok "$1"; }
  warn() { if [ "$(st_state "$CUR")" = "ok" ]; then eval "ST_M_$CUR=\"$1\""; render; else st_set "$CUR" run "$1"; fi; }
  fail() { st_set "$CUR" fail "$1"; }
  hint() { UI_BODY="${UI_BODY}  ${DIM}$1${RST}\n"; render; }
  cmd() { UI_BODY="${UI_BODY}  ${CYN}$1${RST}\n"; render; }
  die() {
    st_set "$CUR" fail "$1"; UI_FOOT="press Enter to leave"
    render; printf '\033[?25h' > /dev/tty 2>/dev/null || true
    IFS= read -r _ < /dev/tty 2>/dev/null || true
    tui_leave; trap - INT TERM; exit 1
  }
  # live_run STEP MSG CMD... — background cmd, animate + tail its log in place.
  live_run() {
    _lr_n=$1; _lr_msg=$2; shift 2
    st_set "$_lr_n" run "$_lr_msg"; UI_BODY=""; UI_LOG=1
    : > .local/qs-step.log
    "$@" > .local/qs-step.log 2>&1 & _lr_pid=$!
    while kill -0 "$_lr_pid" 2>/dev/null; do SPIN_N=$((SPIN_N + 1)); render; sleep 0.4; done
    wait "$_lr_pid" && _lr_rc=0 || _lr_rc=$?
    UI_LOG=0
    return "$_lr_rc"
  }
  # tui_read VAR PROMPT DEFAULT — fullscreen text prompt card.
  tui_read() {
    UI_BODY="  ${B}$2${RST}\n"; UI_FOOT="type + Enter (default: $3)"; UI_LOG=0; render
    printf '\033[?25h' > /dev/tty 2>/dev/null || true
    printf '  > ' > /dev/tty 2>/dev/null || true
    IFS= read -r _tr_val < /dev/tty 2>/dev/null || _tr_val=""
    printf '\033[?25l' > /dev/tty 2>/dev/null || true
    eval "$1=\"\${_tr_val:-$3}\""
    UI_BODY=""; UI_FOOT=""; render
  }
  tui_pause() {
    UI_BODY="  $1\n"; UI_FOOT="press Enter"; UI_LOG=0; render
    printf '\033[?25h' > /dev/tty 2>/dev/null || true
    IFS= read -r _ < /dev/tty 2>/dev/null || true
    printf '\033[?25l' > /dev/tty 2>/dev/null || true
    UI_BODY=""; UI_FOOT=""; render
  }
  # tui_yn PROMPT — fullscreen Yes/No, echoes 0 for yes, 1 for no.
  tui_yn() {
    _yn_r=$(menu_pick "Yes
No" 1 "$1" "")
    [ "$_yn_r" = "1" ]
  }
  pause() { tui_pause "$1"; }
  ask_tty() {
    eval "_a_cur=\${$1:-}"
    if [ -n "$_a_cur" ]; then return 0; fi
    tui_read "$1" "$2" "$3"
  }
  have() { command -v "$1" >/dev/null 2>&1; }
  CUR=0
  tui_enter
  render
else
  # --- plain sequential fallback (no console) -------------------------------
  step() { CUR=$1; printf "\n◆ %s %s\n" "$1/7" "$2"; }
  ok() { printf "  ✓ %s\n" "$1"; }
  warn() { printf "  ! %s\n" "$1"; }
  fail() { printf "  ✗ %s\n" "$1"; }
  hint() { printf "  %s\n" "$1"; }
  cmd() { printf "  %s\n" "$1"; }
  die() { fail "$1"; exit 1; }
  pause() { printf "\n  %s [Enter] " "$1"; IFS= read -r _ < /dev/tty 2>/dev/null || true; }
  ask_tty() {
    eval "cur=\${$1:-}"
    if [ -n "$cur" ]; then return 0; fi
    if [ -e /dev/tty ]; then
      printf "  %s [%s]: " "$2" "$3" > /dev/tty
      IFS= read -r val < /dev/tty 2>/dev/null || val=""
      eval "$1=\${val:-$3}"
    else
      eval "$1=\$3"
    fi
  }
  have() { command -v "$1" >/dev/null 2>&1; }
  live_run() { _n=$1; _m=$2; shift 2; "$@" > /dev/null 2>&1; }
  tui_yn() { return 1; }
  CUR=0
fi

if [ "$TUI" = 0 ]; then
  printf '\n%s\n%sTrulyOpenRouter%s · quickstart · Session %s\n\n' "$QS_MARK" "$B" "$RST" "$QS_SESS"
fi

# --- menu_pick: fullscreen select (nests on our screen under TOR_ALT) --------
menu_pick() {
  _mp_list=$1; _mp_i=${2:-1}; _mp_title=${3:-pick}; _mp_sub=${4:-}
  _mp_n=$(printf '%s\n' "$_mp_list" | grep -c .)
  _mp_tui=0
  if [ -n "${TOR_ALT:-}" ]; then
    _mp_tui=1 # app already owns a console
  elif [ "${TERM:-dumb}" != "dumb" ] && (exec 3<>/dev/tty && stty -g <&3 >/dev/null 2>&1) 2>/dev/null; then
    _mp_tui=1
  fi
  if [ "$_mp_tui" = 0 ]; then
    printf "  pick [1-%s, default %s]: " "$_mp_n" "$_mp_i"
    IFS= read -r _mp_val 2>/dev/null || _mp_val=""
    echo "${_mp_val:-$_mp_i}"
    return 0
  fi
  _mp_old=$(stty -g < /dev/tty 2>/dev/null || echo "")
  _mp_cleanup() {
    if [ -z "${TOR_ALT:-}" ]; then printf '\033[?1049l' > /dev/tty 2>/dev/null || true; fi
    printf '\033[?25h' > /dev/tty 2>/dev/null || true
    stty "$_mp_old" < /dev/tty 2>/dev/null || stty sane < /dev/tty 2>/dev/null || true
  }
  _mp_sig() {
    _mp_cleanup
    if [ -n "${TOR_ALT:-}" ]; then trap 'tui_leave; trap - INT TERM; exit 130' INT TERM; else trap - INT TERM; fi
    kill -s INT $$
  }
  trap _mp_sig INT TERM
  if [ -z "${TOR_ALT:-}" ]; then printf '\033[?1049h' > /dev/tty 2>/dev/null || true; fi
  printf '\033[?25l' > /dev/tty 2>/dev/null || true
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
  if [ -n "${TOR_ALT:-}" ]; then trap 'tui_leave; trap - INT TERM; exit 130' INT TERM; else trap - INT TERM; fi
  echo "$_mp_i"
}

# === 0/7 dependencies ========================================================
step 0 "dependencies"
miss=0
for t in node npm docker cast; do
  if have "$t"; then ok "$t"; else fail "$t — missing"; miss=1; fi
done
[ "$miss" = 0 ] || die "install the missing tools above, then re-run"

# === 1/7 CLI ================================================================
step 1 "fetching the CLI"
if [ "$TUI" = 1 ]; then
  live_run 1 "installing + building tor-host…" sh -c 'cd host-runner/cli && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1' \
    && ok "tor-host ready" || warn "build hiccup — continuing, will retry at link time"
else
  (cd host-runner/cli && npm install --no-audit --no-fund >/dev/null 2>&1 || true && npm run build >/dev/null 2>&1 || true)
fi
if have tor-host; then ok "tor-host on PATH"; else
  warn "linking tor-host (may ask for sudo)…"
  (cd host-runner/cli && (npm link 2>/dev/null || sudo npm link)) || hint "link failed — use: npx --prefix host-runner/cli tsx src/index.ts"
  have tor-host && ok "tor-host on PATH" || warn "tor-host not on PATH yet — open a new terminal"
fi

# === 2/7 hardware → model =====================================================
step 2 "checking your machine"
OS=$(uname -s)
if [ "$OS" = "Darwin" ]; then
  RAM_GB=$(( $(sysctl -n hw.memsize) / 1000000000 ))
  CPU_N=$(sysctl -n hw.ncpu)
  CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Apple Silicon")
  case "$CHIP" in *Apple*|*M1*|*M2*|*M3*|*M4*) GPU="Apple Silicon (unified memory)";; *) GPU="$CHIP";; esac
else
  RAM_GB=$(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo 2>/dev/null || echo 8)
  CPU_N=$(nproc 2>/dev/null || echo 4)
  GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "no discrete GPU")
fi
DISK_FREE=$(df -m "$HOME" 2>/dev/null | awk 'NR==2 {print int($4/1024)}' || echo "?")
HW_SUM="$OS · ${RAM_GB}GB RAM · ${CPU_N} cpu · ${DISK_FREE}GB free · $GPU"
MODELS="qwen2.5:0.5b|0.4|2|tiny · instant · best for testing
qwen2.5:1.5b|1.0|4|small · quick answers
llama3.2:3b|2.0|8|balanced daily driver
qwen2.5:7b|4.7|8|capable · wants room
llama3.1:8b|4.9|16|strong · 16GB+
deepseek-r1:8b|5.2|16|reasoning · slower"
if [ -n "${MODEL_ID:-}" ]; then
  ok "$MODEL_ID (pinned via env) — $HW_SUM"
else
  n=0; def_n=1
  while IFS='|' read -r id size min blurb; do
    [ -n "$id" ] || continue
    n=$((n + 1))
    if awk "BEGIN{exit !( $size <= $RAM_GB * 0.5 )}"; then def_n=$n; fi
  done <<EOF
$MODELS
EOF
  rows=""; n=0
  while IFS='|' read -r id size min blurb; do
    [ -n "$id" ] || continue
    n=$((n + 1))
    if [ "$RAM_GB" -ge "$min" ]; then fit="${GRN}✓ fits${RST}"; else fit="${RED}✗ tight${RST}"; fi
    if [ "$n" -eq "$def_n" ]; then star=" ${YLW}★${RST}"; else star=""; fi
    rows="$rows$(printf "${DIM}%s${RST} %-14s %4sGB · needs %sGB+  %b%s %s" "$n" "$id" "$size" "$min" "$fit" "$star" "$blurb")
"
  done <<EOF
$MODELS
EOF
  rows=$(printf '%s' "$rows" | sed -e '$ { /^$/ d; }')
  if [ "$TUI" = 1 ]; then
    PICK=$(menu_pick "$rows" "$def_n" "pick a model" "$HW_SUM")
  else
    printf '%s\n' "$rows"
    ask_tty PICK "Which model do you want to run?" "$def_n"
  fi
  MODEL_ID=$(printf '%s\n' "$MODELS" | sed -n "${PICK:-$def_n}p" | cut -d'|' -f1)
  [ -n "$MODEL_ID" ] || MODEL_ID="qwen2.5:0.5b"
  ok "$MODEL_ID"
fi

# === 3/7 stack ================================================================
step 3 "starting ollama + guard"
if docker ps -q --filter ancestor=ollama/ollama 2>/dev/null | grep -q .; then
  ok "stack already up, reusing"
else
  for p in 11434 4122; do
    if curl -sf -o /dev/null "http://127.0.0.1:$p/" 2>/dev/null || (echo > "/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      die "port $p is busy — stop whatever holds it first (try: lsof -i :$p), then re-run"
    fi
  done
  if [ "$TUI" = 1 ]; then
    live_run 3 "creating containers…" docker compose -f host-runner/docker-compose.yml up -d ollama guard \
      || die "compose up failed — is Docker running?"
  else
    docker compose -f host-runner/docker-compose.yml up -d ollama guard
  fi
fi
if [ "$TUI" = 1 ]; then
  live_run 3 "pulling $MODEL_ID…" docker exec "$(docker ps -q --filter ancestor=ollama/ollama | head -1)" ollama pull "$MODEL_ID" \
    && ok "guard :4122 · $MODEL_ID ready" || die "model pull failed"
else
  warn "pulling $MODEL_ID (one-time download, a few minutes)…"
  docker exec "$(docker ps -q --filter ancestor=ollama/ollama | head -1)" ollama pull "$MODEL_ID"
  ok "guard :4122 · $MODEL_ID ready"
fi

# === 4/7 hosted backend ========================================================
step 4 "checking the hosted backend"
if [ "$TUI" = 1 ]; then
  live_run 4 "pinging gateway + web…" sh -c "curl -sf -o /dev/null '$PROD_GW/health' && curl -sf -o /dev/null '$PROD_WEB/'" \
    && ok "hosted backend reachable" || die "hosted backend unreachable — check your net, then re-run"
else
  curl -sf "$PROD_GW/health" >/dev/null && ok "gateway up" || die "gateway unreachable"
  curl -sf "$PROD_WEB/" >/dev/null && ok "web up" || die "web unreachable"
fi

# === 5/7 Ledger ================================================================
step 5 "Ledger security"
if ! have wallet-cli; then
  if [ "$TUI" = 1 ]; then
    if tui_yn "Install the Ledger CLI now?"; then
      live_run 5 "npm i -g @ledgerhq/wallet-cli…" sh -c 'npm i -g @ledgerhq/wallet-cli 2>/dev/null || sudo npm i -g @ledgerhq/wallet-cli' \
        && ok "wallet-cli installed" || warn "install failed — run: npm i -g @ledgerhq/wallet-cli"
    else
      warn "skipped — security steps below stay optional"
    fi
  else
    ask_tty INSTALL_WC "Install the Ledger CLI now?" "Y"
    case "$INSTALL_WC" in Y|y|"") (npm i -g @ledgerhq/wallet-cli 2>/dev/null || sudo npm i -g @ledgerhq/wallet-cli) && ok "wallet-cli installed" || warn "install failed";; *) hint "skipped";; esac
  fi
fi
if have wallet-cli; then
  if [ "$TUI" = 1 ]; then
    UI_BODY="  plug in your Ledger, unlock it, open the dashboard app\n"; UI_FOOT="press Enter when ready"; render
    printf '\033[?25h' > /dev/tty 2>/dev/null || true
    IFS= read -r _ < /dev/tty 2>/dev/null || true
    printf '\033[?25l' > /dev/tty 2>/dev/null || true
    UI_BODY=""; UI_FOOT=""; render
    live_run 5 "genuine-check…" wallet-cli genuine-check && ok "device genuine" || warn "plug in, unlock, dashboard app — continuing anyway"
  else
    wallet-cli genuine-check || hint "(plug in, unlock, open the dashboard app — then continue)"
    pause "Device genuine? Continue…"
  fi
  if security find-generic-password -a default -s ledger-wallet-cli >/dev/null 2>&1; then
    ok "ring password already in keychain"
  elif [ "$TUI" = 1 ]; then
    UI_BODY="  creating the keychain entry — type a fresh password twice (I never see it)\n"; UI_FOOT="your terminal asks twice"; render
    if security add-generic-password -a default -s ledger-wallet-cli -w < /dev/tty > /dev/tty 2>&1; then
      ok "password stored in your keychain"
    else
      warn "that failed — run once yourself: security add-generic-password -a default -s ledger-wallet-cli -w"
    fi
    UI_BODY=""; UI_FOOT=""; render
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
  if [ "$TUI" = 1 ]; then
    UI_BODY="  provisioning ring — approve ONCE on the device…\n"; render
    if WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init > .local/qs-step.log 2>&1; then
      ok "ring live — host key and taps are device-backed"
    else
      warn "ring init failed — see .local/qs-step.log (LEDGER-WALKTHROUGH step 2)"
    fi
    UI_BODY=""; render
  else
    warn "provisioning ring — approve ONCE on the device…"
    WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init \
      && ok "ring live — your host key and taps are device-backed" \
      || hint "(see LEDGER-WALKTHROUGH step 2 if that failed)"
  fi
else
  if [ "$TUI" = 1 ]; then st_set 5 skip "no wallet-cli"; else hint "skipped (no wallet-cli)"; fi
fi

# === 6/7 account ===============================================================
step 6 "linking your account"
if [ "$TUI" = 1 ]; then
  UI_BODY="  opening onboarding — log in, subscribe \$10, come back…\n"; UI_FOOT="press Enter when subscribed"; render
else
  hint "opening onboarding — log in, subscribe \$10, come back…"
fi
(open "$PROD_WEB/onboarding" 2>/dev/null || xdg-open "$PROD_WEB/onboarding" 2>/dev/null || true)
pause "Logged in and subscribed? Continue…"
if have tor-host; then
  if [ "$TUI" = 1 ]; then
    UI_BODY="  linking this machine — the approval page opens by itself, one click…\n"; UI_FOOT="approve in the browser, I wait here"; render
    if tor-host login --gateway="$PROD_GW" < /dev/tty > /dev/tty 2>&1; then
      ok "logged in — the claim runs automatically once your host registers below"
    else
      warn "login skipped — run later: tor-host login --gateway=$PROD_GW"
    fi
    UI_BODY=""; UI_FOOT=""; render
  else
    hint "linking this machine — the approval page opens by itself, one click…"
    if tor-host login --gateway="$PROD_GW" < /dev/tty > /dev/tty 2>&1; then
      ok "logged in — the claim runs automatically once your host registers below"
    else
      warn "login skipped — run later: tor-host login --gateway=$PROD_GW"
    fi
  fi
else
  warn "tor-host not on PATH — run later: tor-host login --gateway=$PROD_GW"
fi

# === 7/7 serve =================================================================
step 7 "going live"
TUNNEL_URL=""
if have cloudflared; then ok "cloudflared present"; else
  if [ "$(uname -s)" = "Darwin" ] && have brew; then
    if [ "$TUI" = 1 ]; then
      live_run 7 "brew install cloudflared…" brew install -q cloudflared \
        && ok "cloudflared installed" || warn "brew install failed"
    else
      warn "installing cloudflared (one-time, brew)…"
      brew install -q cloudflared 2>/dev/null && ok "cloudflared installed" || warn "brew install failed"
    fi
  else
    warn "install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  fi
fi
if have cloudflared; then
  mkdir -p .local
  nohup cloudflared tunnel --url http://127.0.0.1:4122 > .local/qs-tunnel.log 2>&1 &
  echo $! > .local/qs-tunnel.pid
  if [ "$TUI" = 1 ]; then
    UI_BODY=""; UI_LOG=0
    i=0; TUNNEL_URL=""
    while [ "$i" -lt 60 ]; do
      TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' .local/qs-tunnel.log 2>/dev/null | head -1 || true)
      if [ -n "$TUNNEL_URL" ]; then break; fi
      SPIN_N=$((SPIN_N + 1)); st_set 7 run "opening tunnel…"; sleep 2; i=$((i + 2))
    done
    if [ -n "$TUNNEL_URL" ]; then ok "public guard URL: $TUNNEL_URL"; else warn "tunnel never printed a URL — see .local/qs-tunnel.log"; kill "$(cat .local/qs-tunnel.pid)" 2>/dev/null || true; fi
  else
    printf "  opening tunnel"
    i=0
    while [ "$i" -lt 60 ]; do
      TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' .local/qs-tunnel.log 2>/dev/null | head -1 || true)
      if [ -n "$TUNNEL_URL" ]; then break; fi
      printf "."; sleep 2; i=$((i + 2))
    done
    printf "\n"
    [ -n "$TUNNEL_URL" ] && ok "public guard URL: $TUNNEL_URL" || { warn "tunnel never printed a URL — see .local/qs-tunnel.log"; kill "$(cat .local/qs-tunnel.pid)" 2>/dev/null || true; }
  fi
fi
ask_tty ENDPOINT "Guard public URL (Enter = tunnel above, or paste your own)" "${TUNNEL_URL:-}"
if [ -z "$ENDPOINT" ]; then
  die "no public URL — without one the network can't route to you (re-run with cloudflared installed)"
fi
if [ "$TUI" = 1 ]; then
  UI_BODY="  registering — host key, testnet stake, owner-claim…\n"; UI_FOOT="underfunded key? it prints the faucet address"; render
  if tor-host run --gateway="$PROD_GW" --model "$MODEL_ID" --endpoint="$ENDPOINT" < /dev/tty > /dev/tty 2>&1; then
    ok "registered"
  else
    UI_BODY=""; UI_FOOT=""; render
    die "run exited — fund the printed address, then re-run just this: tor-host run --gateway=$PROD_GW --model $MODEL_ID --endpoint=$ENDPOINT"
  fi
  UI_BODY=""; UI_FOOT=""; render
else
  hint "registering (generates host key, stakes testnet HBAR, claims for your account)…"
  if tor-host run --gateway="$PROD_GW" --model "$MODEL_ID" --endpoint="$ENDPOINT" < /dev/tty > /dev/tty 2>&1; then
    ok "registered"
  else
    warn "run exited (underfunded host key is the usual cause — it prints the faucet address)"
    die "fund it, then re-run just this step: tor-host run --gateway=$PROD_GW --model $MODEL_ID --endpoint=$ENDPOINT"
  fi
fi
HOST_ADDR=$(node -e "console.log(require(require('os').homedir()+'/.tor/config.json').hostAddress||'')" 2>/dev/null) || HOST_ADDR=""
if [ -n "$HOST_ADDR" ]; then
  SEEN=$(curl -sf "$PROD_GW/api/hosts/$HOST_ADDR" 2>/dev/null || echo "")
  case "$SEEN" in
    *"$ENDPOINT"*|*"endpoint"*) ok "gateway lists you ($HOST_ADDR)";;
    *) warn "gateway doesn't list you yet — heartbeats take ~10 min";;
  esac
  VCODE=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "$PROD_GW/api/verify/$HOST_ADDR" 2>/dev/null || echo "000")
  if [ "$VCODE" = "200" ]; then
    ok "spot-check passed — ROUTABLE, traffic will find you"
  elif [ "$VCODE" = "501" ]; then
    warn "verifier off on the hosted gateway — registered, first live traffic confirms"
  else
    warn "spot-check returned $VCODE — endpoint may be unreachable"
  fi
else
  warn "couldn't read ~/.tor/config.json — check: tor-host status"
fi
(open "$PROD_WEB/host/dashboard" 2>/dev/null || xdg-open "$PROD_WEB/host/dashboard" 2>/dev/null || true)

# === done ======================================================================
if [ "$TUI" = 1 ]; then
  i=0; while [ "$i" -le 7 ]; do eval "_s=\$ST_S_$i"; [ "$_s" = "run" ] && eval "ST_S_$i=ok"; i=$((i + 1)); done
  UI_BODY="  dashboard  ${CYN}$PROD_WEB/host/dashboard${RST}\n  model      ${B}$MODEL_ID${RST}  ${DIM}via $ENDPOINT${RST}\n  status     ${DIM}tor-host status · stop: sh quickstart.sh --stop${RST}\n"
  UI_FOOT="press Enter to leave"; UI_LOG=0; render
  printf '\033[?25h' > /dev/tty 2>/dev/null || true
  IFS= read -r _ < /dev/tty 2>/dev/null || true
  tui_leave; trap - INT TERM
fi
printf "\n  dashboard  %s/host/dashboard\n  model      %s via %s\n  stop       sh quickstart.sh --stop\n" "$PROD_WEB" "$MODEL_ID" "$ENDPOINT"
