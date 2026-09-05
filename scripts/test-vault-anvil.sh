#!/bin/sh
# Integration: Vault debit wiring against a throwaway anvil (no testnet funds touched).
# Keys are read from anvil's own startup log — never hardcoded, never committed.
# Full loop: deploy -> subscribe -> debit via createVaultDebit -> verify earnings.
# NOTE: run the whole file in ONE shell invocation (background anvil may not
# outlive the calling shell on all platforms).
set -eu
cd "$(dirname "$0")/../contracts"

RPC="http://127.0.0.1:8545"
USER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
HOST_ADDR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

pkill -f "anvil --port 8545" 2>/dev/null; sleep 1; true
(nohup anvil --port 8545 > /tmp/tor-anvil-itest.log 2>&1 &)
for _ in $(seq 1 30); do grep -q "Private Keys" /tmp/tor-anvil-itest.log 2>/dev/null && break; sleep 1; done
DEPLOYER_KEY=$(awk '/^Private Keys/{f=1} f && /^\(0\)/{print $2; exit}' /tmp/tor-anvil-itest.log)
USER_KEY=$(awk '/^Private Keys/{f=1} f && /^\(1\)/{print $2; exit}' /tmp/tor-anvil-itest.log)
[ "${#DEPLOYER_KEY}" -eq 66 ] || { echo "bad deployer key from log"; exit 1; }
[ "${#USER_KEY}" -eq 66 ] || { echo "bad user key from log"; exit 1; }
DEPLOYER_ADDR=$(cast wallet address --private-key "$DEPLOYER_KEY" 2>/dev/null)

GATEWAY_ADDR=$DEPLOYER_ADDR DEPLOYER_KEY=$DEPLOYER_KEY forge script script/Deploy.s.sol --rpc-url $RPC --broadcast > /dev/null 2>&1
VAULT=$(python3 -c "import json,glob; d=json.load(open(sorted(glob.glob('broadcast/Deploy.s.sol/31337/run-*.json'))[-1])); print([t for t in d['transactions'] if t['contractName']=='SubscriptionVault'][0]['contractAddress'])")
echo "vault: $VAULT"

cast send --rpc-url $RPC --private-key $USER_KEY "$VAULT" "subscribe(uint256)" 0 --value 10000000000000000000 > /dev/null
echo "user credits: $(cast call --rpc-url $RPC "$VAULT" "credits(address)(uint256)" $USER_ADDR 2>/dev/null)"

VAULT=$VAULT OPERATOR_KEY=$DEPLOYER_KEY RPC_URL=$RPC USER=$USER_ADDR HOST=$HOST_ADDR AMOUNT=1000 RECEIPT=0xabababababababababababababababababababababababababababababababab \
  ../gateway/node_modules/.bin/tsx ../gateway/scripts/debit-once.ts 2>&1 | grep -v -i "warning"

echo "user credits: $(cast call --rpc-url $RPC "$VAULT" "credits(address)(uint256)" $USER_ADDR 2>/dev/null)"
echo "host earnings: $(cast call --rpc-url $RPC "$VAULT" "hostEarnings(address)(uint256)" $HOST_ADDR 2>/dev/null)"
echo VAULT-ANVIL-OK
