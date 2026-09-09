import { api, sh } from "./util.js";
import { createHash } from "crypto";
import { chmodSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { networkInterfaces } from "os";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { configDir, loadConfig, saveConfig } from "./config.js";
import { banner, box, ok, Spinner, warn } from "./ui.js";

const REGISTRY_ABI = parseAbi([
  "function register(string endpoint, string modelId, bytes32 modelDigest, bytes32 imageDigest, uint256 pricePerReq, uint256 pricePer1kTokens, bytes teePubkey) payable",
  "function MIN_STAKE() view returns (uint256)",
  "function getHost(address) view returns ((string endpoint, string modelId, bytes32 modelDigest, bytes32 imageDigest, uint256 pricePerReq, uint256 pricePer1kTokens, bytes teePubkey, uint256 stake, bool active, uint64 registeredAt, uint64 lastHeartbeat, uint64 releaseAfter, bool challenged))",
]);

export interface OnchainHost {
  active: boolean;
  stake: bigint;
}

/// @notice Pure re-run gate: an already-active host skips re-registering
/// (no double stake, no revert) and continues to guard/region/claim.
export function shouldRegister(existing: OnchainHost | null): boolean {
  return !existing || !existing.active;
}

export interface RunOptions {
  gateway: string;
  model: string;
  priceReq?: string;
  price1k?: string;
  region?: string;
  stakeHbar?: string;
  rpcUrl?: string;
  registry?: string;
  endpoint?: string; // override; default = auto-detected LAN IP :4122
}

/// @notice Our own egress-IP geo, resolved host-side. The gateway cannot do this
/// for us: it only sees our endpoint hostname (docker/LAN names resolve to
/// nothing), while we see our own public exit IP. Same slug format as the
/// gateway's observed geo (`cc-region`), free ip-api tier, best-effort.
export async function egressRegion(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetchFn("http://ip-api.com/json/?fields=status,countryCode,regionName", { signal: ctl.signal });
      const d = (await r.json()) as any;
      if (d.status !== "success" || !d.countryCode) return null;
      return `${String(d.countryCode).toLowerCase()}-${String(d.regionName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown"}`;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

/// @notice Ensure this machine has a host key, generating + persisting (0600)
/// on first use. Returns the address and whether it is fresh. The address is
/// saved immediately (before funding/registering) so login can bind the
/// machine to the account and funding pages can find it with zero pasting.
export function ensureHostKey(gateway: string): { address: `0x${string}`; fresh: boolean } {
  const stored = loadConfig();
  let hostKey = stored.hostKey as `0x${string}` | undefined;
  let fresh = false;
  if (!hostKey || !existsSync(join(configDir(), "config.json"))) {
    hostKey = generatePrivateKey();
    saveConfig({ ...stored, gateway, hostKey });
    chmodSync(join(configDir(), "config.json"), 0o600);
    fresh = true;
  }
  const account = privateKeyToAccount(hostKey);
  saveConfig({ ...loadConfig(), gateway, hostAddress: account.address });
  return { address: account.address, fresh };
}

/// @notice First non-internal IPv4 (the address other machines route to).
export function lanIp(): string {
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}


export function digestModelfile(modelfile: string): `0x${string}` {
  return `0x${createHash("sha256").update(modelfile).digest("hex")}`;
}

const COMPOSE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docker-compose.yml");

export async function run(o: RunOptions): Promise<void> {
  console.log(banner());
  const spin = new Spinner();
  try {
    // 1. docker
    spin.start("checking docker");
    const docker = await sh("docker", ["info", "--format", "{{.ServerVersion}}"]);
    if (!docker.ok) throw new Error("Docker not found — install Docker Desktop, then re-run");
    spin.stop(ok(`docker ${docker.out.trim()}`));

    // 2. chain truth (no hardcoded addresses downstream of this point)
    spin.start("reading chain config");
    const cfg = await api(o.gateway, "/api/config");
    const rpcUrl = o.rpcUrl ?? cfg.rpcUrl;
    const registry = (o.registry ?? cfg.registry) as `0x${string}`;
    if (!rpcUrl || !registry) throw new Error("gateway has no chain config yet (REGISTRY/RPC_URL unset server-side)");
    spin.stop(ok(`chain ${cfg.chain} · registry ${registry.slice(0, 10)}…`));

    // 3. ollama up + model pulled
    spin.start("starting ollama");
    await sh("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "ollama"]);
    spin.message(`pulling ${o.model} (first time takes a while)`);
    const pull = await sh("docker", ["compose", "-f", COMPOSE_FILE, "exec", "ollama", "ollama", "pull", o.model], { timeoutMs: 600000 });
    if (!pull.ok) throw new Error(`model pull failed:\n${pull.out}`);
    spin.stop(ok(`model ${o.model}`));

    // 4. healthy?
    spin.start("waiting for healthy model");
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      try {
        const m: any = await (await fetch("http://127.0.0.1:11434/api/tags")).json();
        if ((m.models ?? []).some((x: any) => x.name === o.model || x.name.startsWith(o.model + ":"))) { healthy = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!healthy) throw new Error("ollama unhealthy after 60s — docker logs host-runner-ollama-1");
    const modelfile = (await sh("docker", ["compose", "-f", COMPOSE_FILE, "exec", "ollama", "ollama", "show", "--modelfile", o.model])).out;
    const digest = digestModelfile(modelfile);
    spin.stop(ok(`digest ${digest.slice(0, 14)}…`));

    // 5. host key (generated once, chmod 0600, testnet only for now)
    const { fresh } = ensureHostKey(o.gateway);
    if (fresh) console.log(warn("fresh host key generated — kept in ~/.tor, never leaves this machine"));
    const account = privateKeyToAccount(loadConfig().hostKey as `0x${string}`);
    console.log(ok(`host ${account.address}`));

    // 6. funded? (stake + fees)
    spin.start("checking stake funding");
    const stakeWei = BigInt(Math.round(Number(o.stakeHbar ?? 10))) * BigInt(1e18);
    const pub = createPublicClient({ transport: http(rpcUrl) });
    const balance = await pub.getBalance({ address: account.address });
    if (balance < stakeWei) {
      const need = ((stakeWei - balance) / BigInt(1e18)).toString();
      spin.stop();
      throw new Error(`underfunded: send ≥ ${need} HBAR testnet to ${account.address} (faucet.hedera.com), then re-run`);
    }
    spin.stop(ok(`funded ${(Number(balance) / 1e18).toFixed(1)} HBAR`));

    // 7. register onchain (skipped when this key is already active — re-runs
    // after a partial success must not double-stake or revert).
    const existing = (await pub.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "getHost",
      args: [account.address],
    }).catch(() => null)) as OnchainHost | null;
    if (!shouldRegister(existing)) {
      console.log(ok(`already registered (stake ${(Number(existing!.stake) / 1e18).toFixed(1)} HBAR) — continuing`));
    } else {
      spin.start("registering onchain");
      const wallet = createWalletClient({ account, transport: http(rpcUrl) });
      const minStake = (await pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "MIN_STAKE" })) as bigint;
      if (stakeWei < minStake) throw new Error(`stake below registry minimum`);
      const hash = await wallet.writeContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "register",
        args: [o.endpoint ?? `http://${lanIp()}:4122`, o.model, digest, "0x0000000000000000000000000000000000000000000000000000000000000000", BigInt(o.priceReq ?? 100000), BigInt(o.price1k ?? 100000), "0x"],
        value: stakeWei,
        chain: undefined,
      });
      spin.stop(ok(`registered ${hash.slice(0, 18)}…`));
    }
    saveConfig({ ...loadConfig(), gateway: o.gateway, hostAddress: account.address });

    // 8. guard up (paid serving; dev-mode without HOST_WALLET is local-only)
    spin.start("starting payment guard");
    await sh("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "guard"]);
    spin.stop(ok("guard up — set HOST_WALLET to your 0.0.x id for paid serving"));

    // 9. region attach + owner claim (best-effort — serving works regardless).
    // --region wins; otherwise auto-resolve our own egress IP so every host
    // reports a location without the operator thinking about it.
    let region = o.region;
    if (!region) {
      region = (await egressRegion().catch(() => null)) ?? undefined;
      if (region) console.log(ok(`region ${region} (auto-detected from your IP, override with --region)`));
    }
    if (region) {
      try {
        await api(o.gateway, `/api/hosts/${account.address}/meta`, { method: "POST", body: JSON.stringify({ region }) });
        if (o.region) console.log(ok(`region ${o.region} (self-reported)`));
      } catch (e) {
        console.log(warn(`region sync skipped: ${String((e as Error)?.message ?? e).slice(0, 120)}`));
      }
    } else {
      console.log(warn("no region detected (offline?) — set it with: tor-host run --region <slug>"));
    }
    const me = loadConfig();
    if (me.userId) {
      try {
        await api(o.gateway, `/api/hosts/${account.address}/owner`, { method: "POST", body: JSON.stringify({ userId: me.userId }) });
        console.log(ok(`claimed for account ${me.userId} — see it on /host/dashboard`));
      } catch (e) {
        console.log(warn(`claim skipped: ${String((e as Error)?.message ?? e).slice(0, 120)} — run tor-host link later`));
      }
    } else {
      console.log(warn("not linked to a web account — run `tor-host login`, then `tor-host link`"));
    }
    console.log(box("Discoverable", [`model:    ${o.model}`, `host:     ${account.address}`, `watch:    ${o.gateway.replace(/:\d+$/, ":3002")}/network`]));
  } catch (e) {
    throw e; // index.ts renders once
  }
}
