import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RING_SERVICE, SEALED_KEY, fail, memberAccount, ringStateDir, say } from "./config.mjs";
import { memberCredential, walletPass } from "./ring.mjs";
import { Spinner, banner, box, ok, warn } from "./ui.mjs";

// Enrol a host that has no USB port. Ledger's CLI keeps a machine's Key Ring membership in that
// machine's own keychain, under a name derived from its state path, and offers no way to put one
// there without the device. This does that step: the membership is read on the Mac where the Ledger
// lives and written into the host's keychain, so the host can open Key Ring secrets headlessly.
// Secrets travel on stdin only — never in an argument, an environment variable, or a file.

const PROVISION = `
const { Entry } = require("@napi-rs/keyring");
let data = "";
process.stdin.setEncoding("utf8").on("data", (d) => (data += d)).on("end", () => {
  const { service, account, credential, pass } = JSON.parse(data);
  new Entry(service, account).setPassword(credential);
  new Entry(service, "default").setPassword(pass);
  const back = new Entry(service, account).getPassword();
  console.log(back === credential ? "stored" : "readback mismatch");
  process.exit(back === credential ? 0 : 1);
});
`;

const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", ...opts });

export async function enroll({ container }) {
  say(banner());
  if (!container) fail("Usage: tor-agent enroll --docker <container>");
  if (process.platform !== "darwin") fail("Enrolment reads this Mac's keychain, so run it on the Mac that holds the Ledger.");

  const localState = ringStateDir(homedir());
  if (!existsSync(join(localState, "session.yaml"))) fail(`No Key Ring on this machine (${localState}). Run: wallet-cli ring init`);
  const pass = await walletPass();
  if (!pass) fail(`No Key Ring password. Store it once: security add-generic-password -a default -s ${RING_SERVICE} -w`);

  const home = docker(["exec", container, "printenv", "HOME"]);
  if (home.status !== 0) fail(`Container ${container} is not running: ${String(home.stderr).trim().slice(0, 160)}`);
  const targetHome = home.stdout.trim() || "/root";
  const targetState = `${targetHome}/.local/state/ledger-wallet-cli`;
  const account = memberAccount(targetState);

  let spin = new Spinner().start("reading this Mac's Key Ring membership (macOS may ask you to allow it)");
  const credential = memberCredential(memberAccount(localState));
  if (!credential) {
    spin.stop(warn("the keychain did not return the membership"));
    fail("Click Allow when macOS asks, then run this again.");
  }
  spin.stop(ok("membership read from this Mac's keychain"));

  spin = new Spinner().start(`copying the Key Ring state and the sealed key to ${container}`);
  docker(["exec", container, "mkdir", "-p", targetState, `${targetHome}/.config/trulyopenrouter`]);
  for (const file of ["session.yaml", "first-run.json"]) {
    if (!existsSync(join(localState, file))) continue;
    const copied = docker(["cp", join(localState, file), `${container}:${targetState}/${file}`]);
    if (copied.status !== 0) {
      spin.stop(warn(`copying ${file} failed`));
      fail(String(copied.stderr).trim().slice(0, 200));
    }
  }
  const sealed = existsSync(SEALED_KEY) && docker(["cp", SEALED_KEY, `${container}:${targetHome}/.config/trulyopenrouter/agent-key.enc`]).status === 0;
  spin.stop(ok(sealed ? "state and the sealed agent key copied (ciphertext only)" : "state copied (no sealed agent key yet)"));

  spin = new Spinner().start(`storing the membership in ${container}'s own keychain as ${account}`);
  const provisioned = docker(["exec", "-i", "-w", "/app/agent-cli", container, "node", "-e", PROVISION], {
    input: JSON.stringify({ service: RING_SERVICE, account, credential, pass }),
  });
  if (provisioned.status !== 0) {
    spin.stop(warn("the host keychain rejected it"));
    fail(String(provisioned.stdout || provisioned.stderr).trim().slice(0, 300));
  }
  spin.stop(ok("membership and password stored in the host's keychain"));

  spin = new Spinner().start("checking the host can open the Key Ring on its own");
  const check = docker(["exec", container, "node", "/app/agent-cli/bin/tor-agent.mjs", "ring-check"]);
  if (check.status !== 0) {
    spin.stop(warn("the host could not open the Key Ring"));
    fail(String(check.stdout || check.stderr).trim().slice(0, 300));
  }
  spin.stop(ok("the host opened the sealed agent key with no device attached"));

  say(
    box("Enrolled", [
      `host:       ${container} ${"(no USB port)"}`,
      `key ring:   ${targetState}`,
      `membership: ${account}`,
      ``,
      `It holds ciphertext, a membership and a password, nothing readable.`,
      `Spending past the agent's limits still needs your Ledger.`,
      `Cut it off by removing that membership from the host's keychain.`,
    ]),
  );
}
