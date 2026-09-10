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
# All runtime files (step log, tunnel log) live in a temp dir — the script
# must work on a bare machine with zero repo state. Nothing depends on .local.
QS_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tor-qs.XXXXXX")
QS_LOG="$QS_TMP/step.log"
QS_TUNLOG="$QS_TMP/tunnel.log"
QS_RUN_STATUS="$QS_TMP/run-status.json"
QS_FUNDLOG="$QS_TMP/funding.log"
# tor-host prints its own TOR banner on every command — the app frame already
# carries the brand, so nested runs stay quiet (boxes/spinners still print).
export TOR_QUIET=1

PROD_GW="${PROD_GW:-https://trulyopenrouter.vercel.app/api/gw}"
PROD_WEB="${PROD_WEB:-https://trulyopenrouter.vercel.app}"
MODEL_ID="${MODEL_ID:-}" # env pin; step 2 fills it. Declared here so set -u never trips.
STAKE_HBAR="${STAKE_HBAR:-}" # Omit to use the live registry minimum, with a 10 HBAR default.
QS_SESS=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo "session")
QS_REV=$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")
# Brand mark (TOR block glyphs — widths verified 19 cols, keep aligned).
QS_MARK="█████   ███   ████
  █    █   █  █   █
  █    █   █  ████
  █    █   █  █ █
  █     ███   █  █"
# Brand block shared by every fullscreen screen (app frame + nested pickers).
# Writes to stdout with \r\n ends; callers redirect (render group / /dev/tty).
qs_brand_head() {
  printf '%s\n' "$QS_MARK" | sed 's/^/  /' | while IFS= read -r _ml; do printf '  %s%s%s\r\n' "$B" "$_ml" "$RST"; done
  printf '  %sTrulyOpenRouter%s %squickstart%s\r\n' "$B" "$RST" "$DIM" "$RST"
  printf '  %sSession %s · %s · testnet, free%s\r\n\r\n' "$DIM" "${QS_SESS:-session}" "${QS_REV:-nogit}" "$RST"
}

if [ "${1:-}" = "--stop" ] || [ "${1:-}" = "stop" ]; then
  pkill -f "cloudflared tunnel --url http://127.0.0.1:4122" 2>/dev/null && echo "tunnel down" || true
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

# Strip complete terminal escapes before removing controls, and wrap log lines.
log_tail() {
  _lt_cols=${COLUMNS:-80}
  if [ "$TUI" = 1 ]; then
    _lt_size=$(stty size < /dev/tty 2>/dev/null || true)
    _lt_cols=${_lt_size##* }
  fi
  node host-runner/format-log.mjs "$1" "$2" "${_lt_cols:-80}"
}

if [ "$TUI" = 1 ]; then
  # --- fullscreen app state -------------------------------------------------
  i=0; while [ "$i" -le 7 ]; do eval "ST_S_$i=todo; ST_M_$i=waiting"; i=$((i + 1)); done
  UI_BODY=""; UI_LOG=0; UI_FOOT=""; SPIN_N=0
  UI_LOG_FILE="$QS_LOG"; UI_LOG_LINES=5
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
      qs_brand_head
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
      if [ -n "$UI_BODY" ]; then printf '%b' "$UI_BODY"; fi
      if [ "$UI_LOG" = 1 ]; then log_tail "$UI_LOG_FILE" "$UI_LOG_LINES"; fi
      if [ -n "$UI_FOOT" ]; then printf '\r\n  %s%s%s\r\n' "$DIM" "$UI_FOOT" "$RST"; fi
    } > /dev/tty 2>/dev/null || true
  }
  st_set() { eval "ST_S_$1=\"$2\"; ST_M_$1=\"$3\""; SPIN_N=$((SPIN_N + 1)); render; }
  # render_tick IDX — redraw ONLY the active row + tail zone (no screen clear,
  # no flicker). Layout: header 8 rows, steps at 9..16, divider 18, tail 20...
  render_tick() {
    [ "$UI_LOG" = 1 ] && [ -z "$UI_BODY" ] || { render; return; }
    {
      _tr_row=$((9 + $1))
      printf '\033[%s;1H\033[K  %s%s%s %s/%s %s  %s%s%s\r\n' "$_tr_row" "$YLW" "$(spin_f)" "$RST" "$1" "7" "$(title "$1")" "$DIM" "$(eval "echo \$ST_M_$1")" "$RST"
      printf '\033[20;1H\033[J'
      log_tail "$UI_LOG_FILE" "$UI_LOG_LINES"
      if [ -n "$UI_FOOT" ]; then printf '\r\n  %s%s%s\r\n' "$DIM" "$UI_FOOT" "$RST"; fi
    } > /dev/tty 2>/dev/null || true
    SPIN_N=$((SPIN_N + 1))
  }
  st_state() { eval "echo \$ST_S_$1"; }
  step() { CUR=$1; st_set "$1" run "$2"; UI_BODY=""; UI_LOG=0; UI_FOOT=""; render; }
  ok() { st_set "$CUR" ok "$1"; }
  warn() { if [ "$(st_state "$CUR")" = "ok" ]; then eval "ST_M_$CUR=\"$1\""; render; else st_set "$CUR" run "$1"; fi; }
  fail() { st_set "$CUR" fail "$1"; }
  hint() { UI_BODY="${UI_BODY}  ${DIM}$1${RST}\n"; render; }
  cmd() { UI_BODY="${UI_BODY}  ${CYN}$1${RST}\n"; render; }
  die() {
    UI_LOG=0
    st_set "$CUR" fail "$1"
    if [ -f "$QS_LOG" ]; then
      UI_BODY="  ${DIM}last output:${RST}\n$(log_tail "$QS_LOG" 10)\n"
    else
      UI_BODY=""
    fi
    UI_FOOT="press Enter to leave"
    render; printf '\033[?25h' > /dev/tty 2>/dev/null || true
    IFS= read -r _ < /dev/tty 2>/dev/null || true
    tui_leave; trap - INT TERM; exit 1
  }
  # run_logged CMD... — foreground cmd with stdin on the terminal, output BOTH
  # live (tailed onto the alt screen) and into QS_LOG (survives repaints, so
  # die() can show it). Without this, a failing tor-host run scrolls past and
  # the retry loop + failure card go blind. Returns the command's status.
  run_logged() {
    : > "$QS_LOG"
    "$@" > "$QS_LOG" 2>&1 < /dev/tty & _rl_pid=$!
    tail -f "$QS_LOG" > /dev/tty 2>/dev/null & _rl_tail=$!
    wait "$_rl_pid" && _rl_rc=0 || _rl_rc=$?
    kill "$_rl_tail" 2>/dev/null || true
    return "$_rl_rc"
  }
  # live_run STEP MSG CMD... — background cmd, animate + tail its log in place.
  live_run() {
    _lr_n=$1; _lr_msg=$2; shift 2
    st_set "$_lr_n" run "$_lr_msg"; UI_BODY=""; UI_LOG=1
    UI_LOG_FILE="$QS_LOG"; UI_LOG_LINES=5
    : > "$QS_LOG" || return 1
    # < /dev/null: background steps must never steal keystrokes meant for prompts.
    "$@" > "$QS_LOG" 2>&1 < /dev/null & _lr_pid=$!
    while kill -0 "$_lr_pid" 2>/dev/null; do render_tick "$_lr_n"; sleep 0.4; done
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
  die() { fail "$1"; if [ -f "$QS_LOG" ]; then echo "--- last output:"; log_tail "$QS_LOG" 10; fi; exit 1; }
  run_logged() { "$@" < /dev/tty; }
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
  live_run() {
    _n=$1; _m=$2; shift 2
    printf '  %s\n' "$_m"
    "$@" > "$QS_LOG" 2>&1 < /dev/null && _lr_rc=0 || _lr_rc=$?
    log_tail "$QS_LOG" 10
    return "$_lr_rc"
  }
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
    printf "\033[H\033[J" > /dev/tty 2>/dev/null || true
    if [ -n "${TOR_ALT:-}" ]; then qs_brand_head > /dev/tty 2>/dev/null || true; else printf "\r\n" > /dev/tty 2>/dev/null || true; fi
    printf "  ${B}%s${RST}\r\n" "$_mp_title" > /dev/tty 2>/dev/null || true
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
for t in node npm cast; do
  if have "$t"; then ok "$t"; else fail "$t — missing"; miss=1; fi
done
[ "$miss" = 0 ] || die "install the missing tools above, then re-run"

# Desktop may be installed before its CLI symlinks or shell PATH are set up.
# Keep an existing Docker command/context; only add a fallback when missing.
if ! have docker && [ "$(uname -s)" = "Darwin" ]; then
  for docker_bin in "$HOME/.docker/bin" /Applications/Docker.app/Contents/Resources/bin "$HOME/Applications/Docker.app/Contents/Resources/bin"; do
    if [ -x "$docker_bin/docker" ]; then
      PATH="$docker_bin:$PATH"; export PATH
      break
    fi
  done
fi
if [ "$TUI" = 1 ]; then
  live_run 0 "checking Docker (starting it if needed)…" node host-runner/ensure-docker.mjs \
    || die "Docker needs attention — follow the steps below"
else
  node host-runner/ensure-docker.mjs < /dev/null \
    || die "Docker needs attention — follow the steps above"
fi
ok "tools ready · Docker running"

# === 1/7 CLI ================================================================
step 1 "fetching the CLI"
if [ "$TUI" = 1 ]; then
  live_run 1 "installing + building tor-host…" sh -c 'cd host-runner/cli && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1' \
    && ok "tor-host ready" || die "CLI build failed — see the error below"
else
  (cd host-runner/cli && npm install --no-audit --no-fund && npm run build) || die "CLI build failed"
fi
if have tor-host; then ok "tor-host on PATH"; else
  warn "linking tor-host (may ask for sudo)…"
  (cd host-runner/cli && (npm link 2>/dev/null || sudo npm link)) || hint "link failed — use: npx --prefix host-runner/cli tsx src/index.ts"
  have tor-host && ok "tor-host on PATH" || warn "tor-host not on PATH yet — open a new terminal"
fi

# Use the CLI we just built, even if a global npm link points to another checkout.
QS_CLI="$PWD/host-runner/cli/dist/index.js"
tor_host() { node "$QS_CLI" "$@"; }

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
MODEL_FILE="${TOR_HOME:-$HOME/.tor}/last-model"
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
  # Remember last pick — returning users land on their model, not the biggest.
  if [ -f "$MODEL_FILE" ]; then
    _lm=$(head -1 "$MODEL_FILE" 2>/dev/null || true)
    if [ -n "$_lm" ]; then
      n=0
      while IFS='|' read -r id size min blurb; do
        [ -n "$id" ] || continue
        n=$((n + 1))
        if [ "$id" = "$_lm" ]; then def_n=$n; break; fi
      done <<EOF
$MODELS
EOF
    fi
  fi
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
  [ -n "$MODEL_ID" ] || die "no model selected — re-run step 2"
  mkdir -p "$(dirname "$MODEL_FILE")" 2>/dev/null && echo "$MODEL_ID" > "$MODEL_FILE" 2>/dev/null || true
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
      || die "container startup failed — see the Docker error below"
  else
    docker compose -f host-runner/docker-compose.yml up -d ollama guard \
      || die "container startup failed — see the Docker error above"
  fi
fi
if [ "$TUI" = 1 ]; then
  live_run 3 "pulling ${MODEL_ID}..." docker exec "$(docker ps -q --filter ancestor=ollama/ollama | head -1)" ollama pull "$MODEL_ID" \
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
LEDGER=""
if [ "$TUI" = 1 ]; then
  if tui_yn "Set up a Ledger? (Yes = max security, No = software keys)"; then LEDGER=1; fi
else
  ask_tty LEDGER_YN "Set up a Ledger? (Y = max security, n = software keys — everything still works)" "Y"
  case "$LEDGER_YN" in Y|y|"") LEDGER=1;; esac
fi
if [ -z "$LEDGER" ]; then
  if [ "$TUI" = 1 ]; then st_set 5 skip "software keys — serve, earn, withdraw all work"; else hint "software keys it is — serve, earn, withdraw, everything works"; fi
  hint "add a Ledger anytime: tor-host ledger init"
elif ! have wallet-cli; then
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
if [ -n "$LEDGER" ] && have wallet-cli; then
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
    if WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init > "$QS_LOG" 2>&1; then
      ok "ring live — host key and taps are device-backed"
    else
      warn "ring init failed — see $QS_LOG (LEDGER-WALKTHROUGH step 2)"
    fi
    UI_BODY=""; render
  else
    warn "provisioning ring — approve ONCE on the device…"
    WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w) wallet-cli ring init \
      && ok "ring live — your host key and taps are device-backed" \
      || hint "(see LEDGER-WALKTHROUGH step 2 if that failed)"
  fi
elif [ -n "$LEDGER" ]; then
  if [ "$TUI" = 1 ]; then st_set 5 skip "no wallet-cli"; else hint "skipped (no wallet-cli)"; fi
fi

# === 6/7 account ===============================================================
step 6 "linking your account"
# NOTE: no browser tabs here on purpose. tor-host login below opens its own
# approve URL (login included when logged out), and the funding page opens
# exactly once, at step 7, pre-filled with your host address — only if it is
# actually unfunded. A funding page with no address is never useful.
pause "Continue to login (an approval page opens by itself)…"
if have tor_host; then
  if [ "$TUI" = 1 ]; then
    UI_BODY="  linking this machine — the approval page opens by itself, one click…\n"; UI_FOOT="approve in the browser, I wait here"; render
    if run_logged tor_host login --gateway="$PROD_GW"; then
      ok "logged in — this machine's host key is attached to your account now"
    else
      warn "login skipped — run later: tor-host login --gateway=$PROD_GW"
    fi
    UI_BODY=""; UI_FOOT=""; render
  else
    hint "linking this machine — the approval page opens by itself, one click…"
    if run_logged tor_host login --gateway="$PROD_GW"; then
      ok "logged in — this machine's host key is attached to your account now"
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
  nohup cloudflared tunnel --url http://127.0.0.1:4122 > "$QS_TUNLOG" 2>&1 < /dev/null &
  TUNNEL_PID=$!
  if [ "$TUI" = 1 ]; then
    UI_BODY=""; UI_LOG=0
    i=0; TUNNEL_URL=""
    while [ "$i" -lt 60 ]; do
      TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$QS_TUNLOG" 2>/dev/null | head -1 || true)
      if [ -n "$TUNNEL_URL" ]; then break; fi
      SPIN_N=$((SPIN_N + 1)); st_set 7 run "opening tunnel…"; sleep 2; i=$((i + 2))
    done
    if [ -n "$TUNNEL_URL" ]; then ok "public guard URL: $TUNNEL_URL"; else warn "tunnel never printed a URL — see $QS_TUNLOG"; kill "$TUNNEL_PID" 2>/dev/null || true; fi
  else
    printf "  opening tunnel"
    i=0
    while [ "$i" -lt 60 ]; do
      TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$QS_TUNLOG" 2>/dev/null | head -1 || true)
      if [ -n "$TUNNEL_URL" ]; then break; fi
      printf "."; sleep 2; i=$((i + 2))
    done
    printf "\n"
    [ -n "$TUNNEL_URL" ] && ok "public guard URL: $TUNNEL_URL" || { warn "tunnel never printed a URL — see $QS_TUNLOG"; kill "$TUNNEL_PID" 2>/dev/null || true; }
  fi
fi
ask_tty ENDPOINT "Guard public URL (Enter = tunnel above, or paste your own)" "${TUNNEL_URL:-}"
if [ -z "$ENDPOINT" ]; then
  die "no public URL — without one the network can't route to you (re-run with cloudflared installed)"
fi
if [ "$TUI" = 1 ]; then
  UI_BODY="  registering — host key, testnet stake, owner-claim…\n"; UI_FOOT="underfunded key? I wait for funds below, no re-typing"; render
else
  hint "registering (generates host key, stakes testnet HBAR, claims for your account)…"
fi
# fund_wait ADDR — poll testnet balance until ≥$FUND_NEED HBAR (stake + ~1 gas:
# exactly-10 keys fail the register tx itself, gas has nowhere to come from).
# Compare exact integer wei balances; decimal HBAR is for display only. 0 = funded.
# RPC failures report as unknown (never as zero — a blind check must not claim
# "not funded"). Enter rechecks immediately instead of waiting out the 15s tick.
fund_wait() {
  _fw_i=0; _fw_last=""
  while [ "$_fw_i" -lt "${FW_MAX:-600}" ]; do
    # cast's exit code first (a pipeline would report tr's) — blind ≠ zero.
    # < /dev/null: cast must not slurp Enters meant for the recheck read below.
    if _fw_raw=$(cast balance "$1" --rpc-url "$FUND_RPC" < /dev/null 2>/dev/null) && [ -n "$_fw_raw" ]; then
      _fw_wei=$(printf '%s' "$_fw_raw" | tr -d ' \n')
      case "$_fw_wei" in ''|*[!0-9]*) _fw_ok=0;; *) _fw_ok=1;; esac
    else
      _fw_ok=0
    fi
    if [ "$_fw_ok" = 1 ]; then
      _fw_balance=$(node -e 'console.log((Number(process.argv[1]) / 1e18).toFixed(3).replace(/\.?0+$/, ""))' "$_fw_wei")
      # One line per balance (tail shows a single updating status, not a stack).
      if [ "$_fw_balance" != "$_fw_last" ] || [ "$_fw_i" = 0 ]; then
        echo "Balance: ${_fw_balance} HBAR · Target: $FUND_NEED HBAR"
        _fw_last="$_fw_balance"
      fi
      if node -e 'process.exit(BigInt(process.argv[1]) >= BigInt(process.argv[2]) ? 0 : 1)' "$_fw_wei" "$FUND_WEI"; then return 0; fi
    else
      echo "balance: ? (RPC unreachable — retrying, NOT counted as zero)"
      _fw_last="?"
    fi
    if [ -e /dev/tty ]; then
      # Enter rechecks NOW — and says so, so the keypress is never silent.
      if IFS= read -t 15 -r _ < /dev/tty 2>/dev/null; then echo "(rechecking…)"; fi
    else
      sleep 15
    fi
    _fw_i=$((_fw_i + 15))
  done
  return 1
}
host_addr() {
  node -e 'const p=require("path"); console.log(require(p.join(process.env.TOR_HOME || p.join(require("os").homedir(),".tor"),"config.json")).hostAddress || "")' 2>/dev/null || echo ""
}
registered=""
while [ -z "$registered" ]; do
  if [ "$TUI" = 1 ]; then
    UI_BODY="  checking registration and stake requirements…\n"; UI_FOOT="underfunded key? I wait for funds below, no re-typing"; render
  fi
  set -- run --gateway="$PROD_GW" --model "$MODEL_ID" --endpoint="$ENDPOINT" --status-file="$QS_RUN_STATUS"
  if [ -n "$STAKE_HBAR" ]; then set -- "$@" --stake-hbar="$STAKE_HBAR"; fi
  rm -f "$QS_RUN_STATUS"
  if live_run 7 "checking registration + stake…" tor_host "$@"; then
    registered=1
  else
    # Only a funding shortfall may enter the faucet wait. Other failures stop
    # with their actual error instead of spending three attempts on funding.
    RUN_KIND=$(node -e 'try { console.log(require(process.argv[1]).kind) } catch { console.log("error") }' "$QS_RUN_STATUS")
    [ "$RUN_KIND" = "needs_funds" ] || die "Registration stopped — check the error details"
    funding_field() { node -e 'console.log(require(process.argv[1])[process.argv[2]])' "$QS_RUN_STATUS" "$1"; }
    HOST_ADDR=$(funding_field address)
    STAKE_HBAR=$(funding_field stakeHbar)
    FUND_NEED=$(funding_field totalHbar)
    FUND_WEI=$(funding_field totalWei)
    FUND_RPC=$(funding_field rpcUrl)
    if [ -n "$HOST_ADDR" ]; then
      printf '%s' "$HOST_ADDR" | pbcopy 2>/dev/null || printf '%s' "$HOST_ADDR" | xclip -selection clipboard 2>/dev/null || true
      if [ "$TUI" = 1 ]; then
        UI_BODY="  ${B}Fund your host wallet${RST}\n  $HOST_ADDR\n  Target: $FUND_NEED HBAR ($STAKE_HBAR stake + 1 gas reserve)\n  Faucet: faucet.hedera.com · address copied\n\n"; UI_FOOT="watching it live below — Enter rechecks, funding auto-continues"; render
      else
        ok "fund THIS address (≥$FUND_NEED HBAR = $STAKE_HBAR stake + gas) — host key, not login wallet: $HOST_ADDR"
        hint "copied to clipboard — paste at faucet.hedera.com"
      fi
      (open "$PROD_WEB/host/onboarding?address=$HOST_ADDR&stake=$STAKE_HBAR" 2>/dev/null || xdg-open "$PROD_WEB/host/onboarding?address=$HOST_ADDR&stake=$STAKE_HBAR" 2>/dev/null || true)
      # Each 10-min window ends in keep-waiting-or-quit — the script never
      # times out from under you. Funding waits do not consume retry attempts.
      while :; do
      if [ "$TUI" = 1 ]; then
        UI_LOG=1; UI_LOG_FILE="$QS_FUNDLOG"; UI_LOG_LINES=1
        # Keep funding progress separate so old registration errors do not
        # overwrite the wallet address or reappear below a funded balance.
        : > "$QS_FUNDLOG"
        fund_wait "$HOST_ADDR" >> "$QS_FUNDLOG" 2>&1 & _fw_pid=$!
          while kill -0 "$_fw_pid" 2>/dev/null; do render_tick 7; sleep 2; done
          wait "$_fw_pid" && _fw_rc=0 || _fw_rc=$?
          UI_LOG=0
        else
          hint "watching $HOST_ADDR for stake (faucet payouts can lag minutes — keep this open)…"
          fund_wait "$HOST_ADDR" && _fw_rc=0 || _fw_rc=$?
        fi
        [ "$_fw_rc" = 0 ] && break
        _wf_more=""
        if [ "$TUI" = 1 ]; then
          tui_yn "Still unfunded after 10 min — keep waiting?" && _wf_more=y || true
        else
          KEEPW=""
          ask_tty KEEPW "Still unfunded — keep waiting 10 more min? (Enter = yes, q = quit)" "Y"
          case "$KEEPW" in Y|y|"") _wf_more=y;; esac
        fi
        if [ "$_wf_more" = y ]; then
          [ "$TUI" = 1 ] && { UI_BODY="  still watching $HOST_ADDR…\n"; render; } || hint "watching $HOST_ADDR for 10 more minutes…"
        else
          die "quit — fund $HOST_ADDR, then resume: tor-host run --gateway=$PROD_GW --model $MODEL_ID --endpoint=$ENDPOINT"
        fi
      done
      [ "$TUI" = 1 ] && { UI_BODY="  funded ✓ retrying register…\n"; render; } || ok "funded ✓ retrying register…"
    else
      die "Host address is missing — rerun quickstart to generate a host key"
    fi
  fi
done
[ "$TUI" = 1 ] && { UI_BODY=""; UI_FOOT=""; render; }

ok "registered"
# Belt-and-braces claim (run already claims when logged in; free when not).
live_run 7 "linking your host…" tor_host link --gateway="$PROD_GW" && ok "claimed for your account" || hint "claim later: tor-host link (needs login + registered host)"
HOST_ADDR=$(host_addr)
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
  UI_BODY="  ${B}Welcome — you're serving $MODEL_ID${RST}\n  public URL ${CYN}$ENDPOINT${RST}\n  network    ${CYN}$PROD_WEB/network${RST}  (find yourself as traffic flows)\n  dashboard  ${CYN}$PROD_WEB/host/dashboard${RST}  (live calls + earnings, set prices in tor-host run)\n  status     ${DIM}tor-host status · stop: sh quickstart.sh --stop${RST}\n"
  UI_FOOT="press Enter to leave"; UI_LOG=0; render
  printf '\033[?25h' > /dev/tty 2>/dev/null || true
  IFS= read -r _ < /dev/tty 2>/dev/null || true
  tui_leave; trap - INT TERM
fi
printf "\n  Welcome — you're serving %s\n  public URL %s\n  network    %s/network (find yourself as traffic flows)\n  dashboard  %s/host/dashboard (live calls + earnings)\n  stop       sh quickstart.sh --stop\n" "$MODEL_ID" "$ENDPOINT" "$PROD_WEB" "$PROD_WEB"
