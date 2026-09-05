#!/bin/sh
# Register this host onchain. Env required:
#   REGISTRY, RPC_URL, HOST_KEY, ENDPOINT, MODEL_ID, MODEL_DIGEST,
#   PRICE_PER_REQ_WEI, PRICE_PER_1K_WEI  (IMAGE_DIGEST, STAKE_WEI optional)
set -eu
: "${REGISTRY:?set REGISTRY (HostRegistry address)}"
: "${RPC_URL:?set RPC_URL}"
: "${HOST_KEY:?set HOST_KEY (host ECDSA key)}"
: "${ENDPOINT:?set ENDPOINT (public http url of your Ollama)}"
: "${MODEL_ID:?set MODEL_ID}"
: "${MODEL_DIGEST:?set MODEL_DIGEST (0x sha256 of modelfile)}"

cast send "$REGISTRY" \
  "register(string,string,bytes32,bytes32,uint256,uint256,bytes)" \
  "$ENDPOINT" "$MODEL_ID" "$MODEL_DIGEST" "${IMAGE_DIGEST:-0x0000000000000000000000000000000000000000000000000000000000000000}" \
  "${PRICE_PER_REQ_WEI:-1000000000000}" "${PRICE_PER_1K_WEI:-100000000000}" "0x" \
  --rpc-url "$RPC_URL" --private-key "$HOST_KEY" --value "${STAKE_WEI:-100000000000000000}"
