import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sh } from "./util.js";

export async function enableGuardPayments(address: string, composeFile: string, fetcher: typeof fetch = fetch, shell: typeof sh = sh): Promise<string> {
  const response = await fetcher(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${address}`, { signal: AbortSignal.timeout(10000) });
  const account = await response.json();
  if (!response.ok || !/^0\.0\.[1-9]\d*$/.test(account.account) || account.evm_address?.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Your host's Hedera account is not visible yet. Retry in a few seconds to enable paid serving.");
  }
  const payTo = account.account as string;
  // Persist only the public payee; subsequent setup runs must keep the gate on.
  const envFile = join(dirname(composeFile), ".env");
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const lines = existing.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?HOST_WALLET\s*=/.test(line));
  writeFileSync(envFile, `${lines.join("\n").trimEnd()}\nHOST_WALLET=${payTo}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  const result = await shell("docker", ["compose", "-f", composeFile, "up", "-d", "guard"], { env: { ...process.env, HOST_WALLET: payTo } });
  if (!result.ok) throw new Error("Payment guard startup failed. Check Docker and retry.");
  return payTo;
}
