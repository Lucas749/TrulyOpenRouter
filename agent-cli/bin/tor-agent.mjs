#!/usr/bin/env node
import { say } from "../src/config.mjs";
import { banner, bold, dim } from "../src/ui.mjs";

const COMMANDS = [
  ["seal", "seal an agent key (stdin, or the clipboard on macOS) into the Key Ring"],
  ['run "<task>"', "do one task; it stops for a human when it is over its limit"],
  ["approve", "sign whatever is waiting, from the machine holding the Ledger"],
  ["enroll --docker <name>", "give a host with no USB port its own Key Ring membership"],
  ["status", "limits, usage, and anything waiting for a human"],
];

const help = () =>
  [
    banner(),
    "",
    bold("Usage"),
    ...COMMANDS.map(([name, what]) => `  tor-agent ${name.padEnd(24)} ${dim(what)}`),
    `  ${" ".repeat(10)}${"--approve ledger".padEnd(24)} ${dim("with run: sign that approval on the Ledger on this machine")}`,
    "",
    dim("Environment: TOR_BASE, MODEL, MAX_TOKENS, TOR_AGENT_KEY_ENC, TOR_AGENT_KEY_RING, WALLET_PASS"),
  ]
    .filter((line) => line !== "")
    .join("\n");

const [command, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : fallback;
};
const words = () => rest.filter((word, i) => !word.startsWith("--") && !String(rest[i - 1] ?? "").startsWith("--")).join(" ");

switch (command) {
  case "seal": {
    const { seal } = await import("../src/seal.mjs");
    await seal();
    break;
  }
  case "run": {
    const { run } = await import("../src/run.mjs");
    await run(words(), { approve: flag("approve", process.env.TOR_APPROVE ?? "wait") });
    break;
  }
  case "approve": {
    const { approvePending } = await import("../src/run.mjs");
    await approvePending();
    break;
  }
  case "enroll": {
    const { enroll } = await import("../src/enroll.mjs");
    await enroll({ container: flag("docker") });
    break;
  }
  case "status": {
    const { status } = await import("../src/status.mjs");
    await status();
    break;
  }
  // Used by `enroll` to prove a freshly enrolled host can open the Key Ring on its own.
  case "ring-check": {
    const { unsealAgentKey } = await import("../src/ring.mjs");
    const { ok } = await import("../src/ui.mjs");
    const key = await unsealAgentKey();
    say(ok(`this host opened the sealed agent key (${key.slice(0, 11)}…) from the Key Ring, with no device attached`));
    break;
  }
  default:
    say(help());
    process.exit(command ? 1 : 0);
}
