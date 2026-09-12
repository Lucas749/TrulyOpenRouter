#!/usr/bin/env node
// Guided demo: a remote agent with no USB port, a key it cannot leak, and a Ledger that decides how
// much it may spend. Every step says what it is about to do and waits for you.
//
//   node agent-cli/demo.mjs                 the whole thing
//   node agent-cli/demo.mjs --start 6       resume when the key is sealed and the host enrolled
//   node agent-cli/demo.mjs --start 7       straight to the agent being stopped by its limit
//   node agent-cli/demo.mjs --pause 3       a longer beat between steps (default 1s, 0 at the end)
//   node agent-cli/demo.mjs --wait          the old pacing: press Enter before every step
//
// Env: TOR_DEMO_CONTAINER (default tor-agent-host), TOR_DEMO_AUTO=1 to skip the pauses,
//      TOR_DEMO_STOP_AFTER=request to rehearse everything up to the Ledger press without the device,
//      TOR_DEMO_START_AT=<n> to resume at a step when the earlier ones already hold (a key already
//      sealed and a host already enrolled means 6 and 7 are the useful entry points; starting past
//      5 leaves the host's membership exactly as it is rather than cutting it off and restoring it).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { BASE, SEALED_KEY, memberAccount, ringStateDir } from "./src/config.mjs";
import { Spinner, banner, bold, box, dim, err, ok, warn } from "./src/ui.mjs";

const CONTAINER = process.env.TOR_DEMO_CONTAINER ?? "tor-agent-host";
const COMPOSE = new URL("./docker-compose.yml", import.meta.url).pathname;
const TOR_AGENT = new URL("./bin/tor-agent.mjs", import.meta.url).pathname;
const PROMPT = process.env.TOR_DEMO_PROMPT ?? "Reply with the single word ready";
const AUTO = process.env.TOR_DEMO_AUTO === "1";
// Runs straight through by default so it can be narrated over; --wait restores the
// press-Enter-per-step pacing. --fast stays accepted so older notes keep working.
const WAIT = process.argv.includes("--wait") || process.env.TOR_DEMO_WAIT === "1";
const FAST = !WAIT;
const STOP_AFTER = process.env.TOR_DEMO_STOP_AFTER ?? "";

/// @notice `--start 6` / `--start=6`, falling back to TOR_DEMO_START_AT.
function argValue(name) {
  const spaced = process.argv.indexOf(`--${name}`);
  if (spaced !== -1 && process.argv[spaced + 1]) return process.argv[spaced + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}
const START_AT = Math.max(1, Number(argValue("start") ?? process.env.TOR_DEMO_START_AT ?? 1) || 1);
// Steps 8-10 act on the run that step 7 starts — there is nothing to resume into, and
// step 8 reaches for the Ledger. Refuse rather than skip-and-run.
if (START_AT > 7) {
  console.error(`--start ${START_AT} cannot work: steps 8-10 act on the request step 7 makes. Use --start 7 or lower.`);
  process.exit(1);
}
const APPROVAL_ID = /apr_[0-9a-f]{24}/;

// No readline in fast or auto mode: an open interface holds stdin and the run never exits.
// Seconds on the command line; `--pause 0` really means none.
const pauseArg = Number(argValue("pause") ?? 1);
const PAUSE_MS = Math.max(0, Number.isFinite(pauseArg) ? pauseArg * 1000 : 1000);
const rl = AUTO || FAST ? null : createInterface({ input: process.stdin, output: process.stdout });
const say = (text) => console.log(text);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const agent = (args, opts = {}) => run(process.execPath, [TOR_AGENT, ...args], opts);
const inContainer = (args, opts = {}) => run("docker", ["exec", CONTAINER, ...args], opts);
const output = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

async function pause(text, ms = PAUSE_MS) {
  if (FAST) return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : undefined;
  if (AUTO) return say(dim(`  (${text})`));
  await rl.question(dim(`\n  ${text} `));
}

/// @notice Announce a step and wait. Returns false when the step is being resumed past,
/// so the caller skips the work as well as the prompt: steps 4 and 5 remove and restore a
/// host's membership, and running one without the other would leave it unable to open its key.
async function step(n, title, detail) {
  if (n < START_AT) {
    say(dim(`${n}. ${title} — skipped (resuming at ${START_AT})`));
    return false;
  }
  say("");
  say(`${bold(`${n}. ${title}`)}${detail ? `\n   ${dim(detail)}` : ""}`);
  // The closing steps carry no new idea to talk over, so they run straight through.
  await pause("Press Enter to run this step.", n >= 9 ? 0 : PAUSE_MS);
  return true;
}

function fail(text) {
  say(err(text));
  rl?.close();
  process.exit(1);
}

/// @notice Remove a host's Key Ring membership. Its files stay; it can open nothing.
const revoke = (account) => inContainer(["secret-tool", "clear", "service", "ledger-wallet-cli", "username", account]);

// ---------------------------------------------------------------- preflight

say(banner());
say(
  box("What you are about to see", [
    `1. a secret the agent cannot leak: its key sealed in your Ledger Key Ring`,
    `2. a remote host with no USB port, given the right to open that key`,
    `3. the host asking for work and being stopped by its own limit`,
    `4. your Ledger allowing exactly that spend, once`,
    `5. the answer coming back, with the host paid on Hedera`,
  ]),
);

if (!run("which", ["wallet-cli"]).stdout.trim()) fail("Ledger's wallet-cli is not installed: npm i -g @ledgerhq/wallet-cli");
if (run("docker", ["info"], { stdio: "ignore" }).status !== 0) fail("Docker is not running.");

// --------------------------------------------------- 1. where the agent comes from

if (await step(1, "The agent is created in the signed-in web app", "Its limits and its Ledger are set here, once, by a human.")) {
  const SITE = BASE.replace("/api/gw", "");
  if (process.platform === "darwin") spawnSync("open", [`${SITE}/agents`]);
  say(
    box("On screen at /agents", [
      `New agent   → "Agent name", then "Funding source" (personal or a team)`,
      `limits      → "Credits per UTC day" is 0 here, so the first task must ask`,
      `checkbox    → "Credit limits may request a human approval" stays on`,
      `Create agent→ "Key for <name>, shown once", with Copy next to it`,
      `Connect Ledger → the device shows its address, then signs the enrolment`,
      ``,
      `That key is what gets sealed below. It is never stored in readable form.`,
    ]),
  );
}

if (!existsSync(SEALED_KEY)) fail(`No sealed agent key yet. Copy the key from that page, then run: node agent-cli/bin/tor-agent.mjs seal`);

// ------------------------------------------------------- 2. the sealed key

if (await step(2, "The agent's key is sealed in the Ledger Key Ring", "Nothing readable is on disk. This is what an attacker would find.")) {
  const sealed = readFileSync(SEALED_KEY);
  say(
    box("On disk", [
      `file:  ${SEALED_KEY.replace(homedir(), "~")}`,
      `size:  ${sealed.length} bytes of ciphertext`,
      `bytes: ${sealed.subarray(0, 24).toString("hex")}…`,
    ]),
  );
  say(dim("  keys this machine keeps on the ring:"));
  spawnSync("wallet-cli", ["ring", "keys"], { stdio: "inherit" });
}

// --------------------------------------------------- 3. a host with no USB

const showHost = await step(3, `Bring up ${CONTAINER}: a host with no USB port`, "A plain Linux box. No Ledger can ever be plugged into it.");
if (showHost && inContainer(["true"]).status !== 0) {
  const spin = new Spinner().start("starting the container");
  const up = run("docker", ["compose", "-f", COMPOSE, "up", "-d", "--build"]);
  spin.stop(up.status === 0 ? ok("container running") : warn("could not start the container"));
  if (up.status !== 0) fail(String(up.stderr).slice(0, 300));
} else if (showHost) {
  say(ok("container already running"));
}
// Needed by steps 4 and 10 even when this step is skipped, so it is read either way.
const targetHome = inContainer(["printenv", "HOME"]).stdout.trim() || "/root";
const account = memberAccount(ringStateDir(targetHome));
if (showHost) {
  const usb = inContainer(["sh", "-lc", "ls /dev/bus/usb 2>/dev/null | wc -l"]).stdout.trim();
  say(
    box("The host", [
      `name:        ${CONTAINER}`,
      `USB devices: ${usb} (a Ledger cannot be attached to it)`,
      `membership:  ${account}`,
    ]),
  );
}

// ------------------------------------------- 4. locked out before enrolment

// Skipping this must skip the revoke itself: cutting the host off without step 5 to
// restore it would leave it unable to open its key for the rest of the demo.
if (await step(4, "Show that the host cannot open the secret yet", "Removing its Key Ring membership puts it back to a fresh machine.")) {
  revoke(account);
  const locked = inContainer(["tor-agent", "ring-check"]);
  say(locked.status === 0 ? warn("the host could still open it") : ok("the host cannot open the sealed key: no Key Ring membership"));
}

// --------------------------------------------------------- 5. enrol the host

if (await step(5, "Enrol the host from this Mac", "The Ledger stays here. Only the right to open Key Ring secrets travels, over stdin.")) {
  if (agent(["enroll", "--docker", CONTAINER], { stdio: "inherit" }).status !== 0) fail("Enrolment failed.");
}

if (await step(6, "Ask the host what it can see", "It opens the key with no device attached, and reads its own limits from the gateway.")) {
  const before = inContainer(["tor-agent", "status"]);
  say(output(before).trim());
  if (APPROVAL_ID.test(output(before))) say(dim("  (an approval is already waiting; this demo signs the one it creates, by id)"));
}

// ------------------------------------------- 7. the host asks, and is stopped

await step(7, "The host tries to do work", "Its daily limit stops the request. Nothing is sent, and no host is paid.");
const child = spawn("docker", ["exec", "-e", "MAX_TOKENS=32", CONTAINER, "tor-agent", "run", PROMPT], { stdio: ["ignore", "pipe", "pipe"] });
let transcript = "";
for (const stream of [child.stdout, child.stderr]) stream.setEncoding("utf8").on("data", (d) => (transcript += d));

const spin = new Spinner().start("the remote agent is asking the network");
const stopped = await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (/over the agent's limit/.test(transcript)) return clearInterval(timer), resolve(true);
    if (child.exitCode !== null) return clearInterval(timer), resolve(false);
  }, 300);
});
spin.stop(stopped ? warn("stopped by its own limit, before any host was contacted") : err("the run ended without asking for an approval"));
say(transcript.trim());
if (!stopped) fail("Expected the agent to be over its limit: set its credits per UTC day to 0 on /agents, then run this again.");

// The id is read back from the gateway, so what is shown is the approval the server actually holds.
const approval = (output(inContainer(["tor-agent", "status"])).match(APPROVAL_ID) ?? transcript.match(APPROVAL_ID) ?? [])[0];
say(
  box("Who asked for what", [
    `the remote agent asked for work, and the gateway refused it`,
    `the gateway created approval ${approval ?? "(id unavailable)"}`,
    `the agent cannot approve it: only the enrolled Ledger's signature counts`,
    `a human can also decide it in a browser, at the link above`,
  ]),
);

if (STOP_AFTER === "request") {
  child.kill();
  say(ok("rehearsal finished before the Ledger step"));
  rl?.close();
  process.exit(0);
}

// ------------------------------------------------------- 8. the Ledger press

await step(8, "Allow that spend on your Ledger", "Plug in the Ledger, unlock it, open the Ethereum app, and quit Ledger Live.");
// Name the approval, so an older one waiting cannot be signed in place of this one.
agent(["approve", ...(approval ? [approval] : [])], { stdio: "inherit" });

// ------------------------------------------------- 9. the answer comes back

await step(9, "The remote agent finishes on its own", "It was waiting for your decision, not for a new command.");
const code = await new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on("close", resolve)));
say(transcript.trim().split("\n").slice(-14).join("\n"));
if (code !== 0) fail("The remote run did not finish cleanly.");

const receipt = (transcript.match(/receipt:\s*([0-9a-f]{64})/) ?? [])[1];
if (receipt) {
  const spin2 = new Spinner().start("checking the payment on Hedera");
  const detail = await fetch(`${BASE}/api/receipts/${receipt}`).then((r) => r.json()).catch(() => null);
  const tx = detail?.x402Transaction;
  const onChain = tx
    ? await fetch(`https://testnet.mirrornode.hedera.com/api/v1/transactions/${tx.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`)
        .then((r) => r.json())
        .catch(() => null)
    : null;
  const paid = (onChain?.transactions?.[0]?.token_transfers ?? []).find((t) => t.amount > 0);
  spin2.stop(ok("payment checked on the mirror node"));
  say(
    box("Proof", [
      `receipt:  ${receipt.slice(0, 32)}…`,
      `credits:  ${detail?.amountCredits ?? "?"} · approved as ${detail?.grant ?? "?"}`,
      `payment:  ${tx ?? "none"}`,
      `on chain: ${onChain?.transactions?.[0]?.result ?? "not indexed yet"}${paid ? ` · ${paid.amount} units to ${paid.account}` : ""}`,
    ]),
  );
}

// ----------------------------------------------------------- 10. cut it off

// Guarded like step 4: resuming past this must not quietly cut the host off.
if (await step(10, "Cut the host off", "Remove its membership. Every file stays where it is, and it can open nothing.")) {
  revoke(account);
  const after = inContainer(["tor-agent", "ring-check"]);
  say(after.status === 0 ? warn("the host can still open the key") : ok("the host can no longer open the sealed key"));
}

say(
  box("What this showed", [
    `the agent's key was never readable on disk, here or on the host`,
    `a host with no USB port was given, then denied, the right to open it`,
    `the host could ask to spend more, but only your Ledger could allow it`,
    `one press bought one request, and the host was paid on Hedera for it`,
  ]),
);
rl?.close();
