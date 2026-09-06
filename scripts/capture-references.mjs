#!/usr/bin/env node
// Capture fingerprint references from a TRUSTED local run of the serving stack.
// Usage: OLLAMA_URL=http://127.0.0.1:11434 MODEL=qwen2.5:0.5b node scripts/capture-references.mjs
// Writes gateway/references.json[{modelId: {probeId: normalizedExpected}}].
// Honesty rule: references are only valid for the same stack (Ollama version + quant).
// Re-capture when the host-runner image changes; record the stack alongside.
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const MODEL = process.env.MODEL ?? "qwen2.5:0.5b";
const OUT = new URL("../gateway/references.json", import.meta.url);

const { PROBES, VERIFY_SEED, normalizeCompletion } = await import("../gateway/src/verify.ts");

let stack = "unknown";
try {
  stack = execSync("docker compose -f host-runner/docker-compose.yml exec ollama ollama --version", { encoding: "utf8" }).trim();
} catch { /* best effort */ }

const refs = {};
for (const probe of PROBES) {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: probe.messages,
      temperature: 0,
      seed: VERIFY_SEED,
      max_tokens: probe.maxTokens,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`probe ${probe.id}: upstream ${res.status}`);
  const content = (await res.json())?.choices?.[0]?.message?.content ?? "";
  refs[probe.id] = normalizeCompletion(content);
  console.log(`${probe.id}: ${JSON.stringify(content)} -> ${JSON.stringify(refs[probe.id])}`);
}

let all = {};
try { all = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* first capture */ }
all[MODEL] = { stack, capturedAt: new Date().toISOString(), refs };
writeFileSync(OUT, JSON.stringify(all, null, 2) + "\n");
console.log(`wrote ${MODEL} (${Object.keys(refs).length} probes) stack=${stack}`);
