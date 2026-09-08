#!/bin/sh
# TrulyOpenRouter one-line install. Pulls the repo and hands off to quickstart.sh.
# Usage: curl -fsSL https://trulyopenrouter.vercel.app/install.sh | bash
# Testnet only. Nothing here costs money. Your host key never leaves your machine.
set -eu
if command -v git >/dev/null 2>&1; then
  if [ -d TrulyOpenRouter ]; then
    echo "TrulyOpenRouter/ exists — updating…"
    (cd TrulyOpenRouter && git pull -q || true)
  else
    git clone -q https://github.com/Lucas749/TrulyOpenRouter
  fi
  cd TrulyOpenRouter
  sh quickstart.sh
else
  echo "need git first: https://git-scm.com/downloads"
  exit 1
fi
