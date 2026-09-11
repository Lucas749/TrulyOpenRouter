#!/bin/sh
# Provision Ledger Key Ring ciphertext for the gateway (run ONCE per secret,
# or to rotate). Values come from YOUR current environment — this script never
# prints them. Ciphertext (*.enc) is safe to commit; the key stays in the
# Ledger trustchain + WALLET_PASS.
#
# Usage (values from repo-root .env, nothing echoed):
#   set -a; source ../.env; set +a
#   ./scripts/ring-provision.sh
#
# Requires: wallet-cli ring init done, WALLET_PASS exported or in env.
set -eu
cd "$(dirname "$0")/.."
mkdir -p secrets

prov() {
  env_name="$1"; short="$2"
  val="$(eval "echo \${$env_name:-}")"
  if [ -z "$val" ]; then echo "skip $env_name (empty/unset)"; return 0; fi
  printf '%s' "$val" | WALLET_PASS="$WALLET_PASS" wallet-cli ring encrypt --key "tor/$short" > "secrets/$short.enc"
  echo "wrote secrets/$short.enc (tor/$short)"
}

: "${WALLET_PASS:?export WALLET_PASS first: WALLET_PASS=\$(security find-generic-password -a default -s ledger-wallet-cli -w)}"
prov BUDGET_MASTER budget-master
prov OPERATOR_KEY vault-operator
prov X402_PAYER_KEY x402-payer
prov HCS_OPERATOR_KEY hcs-operator
prov HOST_KEY host
prov PRIVY_BROKER_AUTH_KEY privy-broker
echo "done — ciphertext only; verify with: git status --short secrets/"
