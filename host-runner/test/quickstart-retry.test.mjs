import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercise the actual shell retry loop without Docker, a browser, or chain writes.
const source = readFileSync(new URL("../../quickstart.sh", import.meta.url), "utf8");
const loop = source.slice(source.indexOf('registered=""'), source.indexOf('\nok "registered"'));
function run(mode) {
  const dir = mkdtempSync(join(tmpdir(), "tor-retry-"));
  try {
    return spawnSync("/bin/sh", ["-c", `
set -eu
TUI=0; STAKE_HBAR=""; PROD_GW=https://example.test; PROD_WEB=https://example.test
MODEL_ID=test; ENDPOINT=https://host.test; QS_RUN_STATUS="$TOR_TEST_DIR/status.json"
QS_LOG="$TOR_TEST_DIR/run.log"
attempt=0; waits=0
die() { echo "stopped: $1"; exit 1; }
ok() { echo "$1"; }
hint() { echo "$1"; }
pause() { :; }
pbcopy() { cat >/dev/null; }
open() { echo browser; }
ask_tty() { KEEPW=Y; }
fund_wait() {
  echo "fund-wait: $FUND_NEED $STAKE_HBAR $FUND_WEI $FUND_RPC"
  waits=$((waits + 1))
  [ "$waits" -gt 1 ]
}
run_logged() {
  attempt=$((attempt + 1)); echo "attempt: $attempt"
  if [ "$attempt" -gt 1 ]; then return 0; fi
  if [ "$TOR_TEST_MODE" = funds ]; then
    printf '%s' '{"kind":"needs_funds","address":"0x1111111111111111111111111111111111111111","stakeHbar":"10","totalHbar":"11","totalWei":"11000000000000000000","rpcUrl":"https://rpc.test"}' > "$QS_RUN_STATUS"
  else
    printf '%s' '{"kind":"error"}' > "$QS_RUN_STATUS"
  fi
  return 1
}
${loop}
echo completed
`], { encoding: "utf8", timeout: 10000, env: { ...process.env, TOR_TEST_DIR: dir, TOR_TEST_MODE: mode } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("registration errors stop once without opening the faucet or waiting for funds", () => {
  const result = run("error");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Registration stopped/);
  assert.doesNotMatch(result.stdout, /fund-wait|browser|attempt: 2/);
});

test("funding waits use the transaction target and resume after a later successful wait", () => {
  const result = run("funds");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fund-wait: 11 10 11000000000000000000 https:\/\/rpc.test/);
  assert.equal((result.stdout.match(/fund-wait:/g) ?? []).length, 2);
  assert.match(result.stdout, /attempt: 2\ncompleted/);
});
