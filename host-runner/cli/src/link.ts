import { loadConfig } from "./config.js";

/// @notice Claim this machine's host for the logged-in web account.
export async function link(gateway: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.userId) throw new Error("not logged in — run tor-host login first");
  if (!cfg.hostAddress) throw new Error("no host yet — run tor-host run first");
  const res = await fetch(`${gateway}/api/hosts/${cfg.hostAddress}/owner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: cfg.userId }),
  });
  if (!res.ok) throw new Error(`claim failed: ${res.status}`);
  console.log(`claimed ✓ ${cfg.hostAddress} for account ${cfg.userId}`);
}
