#!/bin/sh
# Local end-to-end: gateway -> Ollama (qwen2.5:0.5b) with a scoped API key.
# Expects: ollama serve running, model pulled. No chain, no funds needed.
set -eu
cd "$(dirname "$0")/../gateway"

export PORT=4121
export UPSTREAM_URL="http://127.0.0.1:11434"
npx tsx src/index.ts > /tmp/tor-gateway.log 2>&1 &
GW=$!
trap "kill $GW" EXIT
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" > /dev/null && break; sleep 1; done

KEY=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/keys" \
  -H "Content-Type: application/json" \
  -d '{"scopes":{"models":["qwen2.5:0.5b"]}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['key'])")
echo "key: ${KEY%????????????????}…(redacted)"

curl -sf -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"Say apple."}],"stream":false}' \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('reply:', d['choices'][0]['message']['content'][:120])
print('receipt:', d.get('tor_receipt'), '| settled:', d.get('tor_settled'))
assert d.get('tor_receipt'), 'missing receipt'
"
echo E2E-OK
