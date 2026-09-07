import { sh } from "./util.js";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.js";
import { box, ok, Spinner, warn } from "./ui.js";

const REGISTRY_ABI = parseAbi([
  "function deregister()",
  "function release()",
  "function getHost(address) view returns ((string endpoint, string modelId, bytes32 modelDigest, bytes32 imageDigest, uint256 pricePerReq, uint256 pricePer1kTokens, bytes teePubkey, uint256 stake, bool active, uint64 registeredAt, uint64 lastHeartbeat, uint64 releaseAfter, bool challenged))",
]);
const VAULT_ABI = parseAbi(["function withdraw()"]);
const COMPOSE_FILE = new URL("../../docker-compose.yml", import.meta.url).pathname;


export interface LeaveOptions {
  gateway: string;
  rpcUrl: string;
  registry: string;
  vault: string;
  dryRun?: boolean;
}

export async function leave(o: LeaveOptions): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.hostKey || !cfg.hostAddress) throw new Error("no host here — nothing to leave (run tor-host run first)");
  const account = privateKeyToAccount(cfg.hostKey as `0x${string}`);
  const pub = createPublicClient({ transport: http(o.rpcUrl) });
  const host: any = await pub.readContract({
    address: o.registry as `0x${string}`,
    abi: REGISTRY_ABI,
    functionName: "getHost",
    args: [account.address],
  });
  const lines = [
    `host:     ${account.address}`,
    `active:   ${host.active} · stake ${host.stake} · releaseAfter ${host.releaseAfter}`,
  ];
  if (o.dryRun) {
    console.log(box("Leave plan (dry run, nothing sent)", [...lines, ``, `1. deregister() — stops routing, starts timelock`, `2. withdraw() on vault — pulls earnings`, `3. release() after timelock — stake back`, `4. docker compose stop guard`]));
    return;
  }
  const spin = new Spinner();
  const wallet = createWalletClient({ account, transport: http(o.rpcUrl) });
  if (host.active) {
    spin.start("deregistering (stops new routes)");
    await wallet.writeContract({ address: o.registry as `0x${string}`, abi: REGISTRY_ABI, functionName: "deregister", chain: undefined });
    spin.stop(ok("deregistered — timelock running"));
  } else {
    console.log(warn("already deregistered — skipping"));
  }
  spin.start("withdrawing vault earnings");
  try {
    const h = await wallet.writeContract({ address: o.vault as `0x${string}`, abi: VAULT_ABI, functionName: "withdraw", chain: undefined });
    spin.stop(ok(`earnings withdrawn ${h.slice(0, 18)}…`));
  } catch {
    spin.stop(warn("nothing to withdraw (or already claimed)"));
  }
  await sh("docker", ["compose", "-f", COMPOSE_FILE, "stop", "guard"]);
  console.log(box("Left", [...lines.slice(0, 2), ``, `release() unlocks after the timelock — then funds return automatically on call`, `guest book stays: receipts remain verifiable on /network`]));
}
