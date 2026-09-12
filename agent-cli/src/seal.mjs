import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { RING_KEY, fail, say } from "./config.mjs";
import { sealAgentKey } from "./ring.mjs";
import { Spinner, banner, box, ok } from "./ui.mjs";

/// @notice Seal an agent key into the Ledger Key Ring. The key arrives on stdin or from the clipboard,
/// is never written in plaintext, and never appears in an argument or in the shell history.
export async function seal() {
  say(banner());
  let key = "";
  if (!process.stdin.isTTY) {
    key = await new Promise((resolve) => {
      let text = "";
      process.stdin.setEncoding("utf8").on("data", (d) => (text += d)).on("end", () => resolve(text));
    });
  } else if (process.platform === "darwin") {
    say(ok("reading the agent key from the clipboard (copy it from /agents first)"));
    key = spawnSync("pbpaste", { encoding: "utf8" }).stdout ?? "";
  }
  if (!key.trim()) fail("No agent key. Copy it from /agents and run `tor-agent seal`, or pipe it in.");

  const spin = new Spinner().start(`sealing under ${RING_KEY} in the Ledger Key Ring`);
  const file = await sealAgentKey(key);
  spin.stop(ok("sealed"));
  if (process.platform === "darwin") spawnSync("sh", ["-c", "pbcopy < /dev/null"]);

  say(
    box("Sealed", [
      `ring key:   ${RING_KEY}`,
      `ciphertext: ${file.replace(homedir(), "~")}`,
      ``,
      `Opening it needs this machine's Key Ring membership and password.`,
      `Nothing readable is on disk, and the clipboard was cleared.`,
    ]),
  );
}
