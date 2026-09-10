import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLog } from "../format-log.mjs";

test("removes whole color and terminal-control sequences", () => {
  const output = formatLog("\x1b[32m✓\x1b[0m host ready\n\x1b[2Kchecking registration...\n\x1b]0;bad title\x07Balance: 10 HBAR");
  assert.equal(output, "  ✓ host ready\n  checking registration...\n  Balance: 10 HBAR");
});

test("wraps long errors to the terminal width while preserving their text", () => {
  const message = "Registration needs 10 HBAR of stake; the transaction supplied 5 HBAR.";
  const output = formatLog(message, { width: 40 });
  assert.ok(output.split("\n").every((line) => [...line].length <= 40));
  assert.equal(output.split("\n").map((line) => line.trim()).join(" "), message);
});

test("keeps only recent progress and preserves wallet addresses", () => {
  const address = "0xFc2742c7dB2E2eD3B90A201170b75d7BAc5BD4fF";
  const output = formatLog(`old output\rpulling aabbccddeeff: 10% spam\rpulling aabbccddeeff: 20% spam\nHost: ${address}`, { width: 80, lines: 2 });
  assert.equal(output, `  pulling aabb… 20%\n  Host: ${address}`);
});
