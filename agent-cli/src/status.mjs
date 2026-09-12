import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { BASE, RING_KEY, SEALED_KEY, say } from "./config.mjs";
import { unsealAgentKey, walletPass } from "./ring.mjs";
import { Spinner, banner, box, ok, warn } from "./ui.mjs";

/// @notice What this machine can do: where the key is sealed, whether the Key Ring opens it here, and
/// what the gateway says about the agent's limits, usage, and anything waiting for a human.
export async function status() {
  say(banner());
  const sealedPath = SEALED_KEY.replace(homedir(), "~");
  say(existsSync(SEALED_KEY) ? ok(`sealed agent key ${sealedPath} (ring key ${RING_KEY})`) : warn(`no sealed agent key at ${sealedPath}, run: tor-agent seal`));
  say((await walletPass()) ? ok("Key Ring password found in this machine's keychain") : warn("no Key Ring password in this machine's keychain"));

  const spin = new Spinner().start("opening the agent key from the Key Ring");
  const key = await unsealAgentKey();
  spin.stop(ok("Key Ring opened the agent key, with no device attached"));

  const res = await fetch(`${BASE}/v1/agent/self`, { headers: { Authorization: `Bearer ${key}` } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) return say(warn(`the gateway answered ${res.status}: ${d?.error?.message ?? ""}`));

  const { agent, policy, usage, approvals } = d;
  const limit = (v) => (v === null || v === undefined ? "none" : `${v} credits`);
  const pending = (approvals ?? []).filter((a) => a.state === "pending");
  say(
    box("Agent", [
      `name:    ${agent.name} (${agent.id})`,
      `state:   ${agent.state}`,
      `pays:    ${agent.payerKind === "team" ? `team ${agent.orgId}` : "its own budget"}`,
      `gateway: ${BASE}`,
      ``,
      `day ${limit(policy?.dailyCredits)} · month ${limit(policy?.monthlyCredits)}`,
      `lifetime ${limit(policy?.lifetimeCredits)} · per request ${limit(policy?.maxRequestCredits)}`,
      `used:    ${JSON.stringify(usage ?? {})}`.slice(0, 52),
      ``,
      pending.length ? `waiting for you: ${pending.map((a) => `${a.id} (+${a.additional_credits})`).join(", ")}` : `nothing waiting for a human`,
    ]),
  );
}
