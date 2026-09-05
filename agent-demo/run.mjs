#!/usr/bin/env node
// Budget-capped agent demo: issues a scoped key, spends it on prompts, stops at cap.
// Env: GATEWAY (default http://127.0.0.1:4021), MODEL, BUDGET_CREDITS (default 5), PROMPT.
// No chain needed locally; against testnet the same flow pays x402 per call.
const GATEWAY = process.env.GATEWAY ?? "http://127.0.0.1:4021";
const MODEL = process.env.MODEL ?? "qwen2.5:0.5b";
const BUDGET = Number(process.env.BUDGET_CREDITS ?? 5);
const PROMPT = process.env.PROMPT ?? "Explain hash functions in one sentence.";

const keyRes = await fetch(`${GATEWAY}/api/keys`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ scopes: { models: [MODEL] } }),
});
if (!keyRes.ok) throw new Error(`key issue failed: ${keyRes.status}`);
const { key, prefix } = await keyRes.json();
console.log(`key ${prefix}… budget: ${BUDGET} calls`);

let spent = 0;
for (let i = 0; i < BUDGET; i++) {
  const r = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: `${PROMPT} (n=${i})` }] }),
  });
  if (r.status === 401 || r.status === 429) {
    console.log(`stopped by gateway: ${r.status}`);
    break;
  }
  const d = await r.json();
  spent++;
  console.log(`[${spent}/${BUDGET}] receipt ${d.tor_receipt?.slice(0, 12)}… settled=${d.tor_settled} :: ${String(d.choices?.[0]?.message?.content ?? "").slice(0, 80)}`);
}
console.log(`AGENT-DONE spent=${spent} budget=${BUDGET}`);
