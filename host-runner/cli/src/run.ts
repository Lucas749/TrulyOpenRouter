import { execFile } from "child_process";
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
]);

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

/// @notice First non-internal IPv4 (the address other machines route to).
export function lanIp(): string {
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

function sh(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts?.timeoutMs ?? 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || stderr).slice(0, 2000) });
    });
  });
}

async function api(gateway: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${gateway}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
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
    const stored = loadConfig();
    let hostKey = stored.hostKey as `0x${string}` | undefined;
    if (!hostKey || !existsSync(join(configDir(), "config.json"))) {
      hostKey = generatePrivateKey();
      saveConfig({ ...stored, gateway: o.gateway, hostKey });
      chmodSync(join(configDir(), "config.json"), 0o600);
      console.log(warn("fresh host key generated — kept in ~/.tor, never leaves this machine"));
    }
    const account = privateKeyToAccount(hostKey);
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

    // 7. register onchain
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
    saveConfig({ ...loadConfig(), gateway: o.gateway, hostAddress: account.address });
    spin.stop(ok(`registered ${hash.slice(0, 18)}…`));

    // 8. guard up (paid serving; dev-mode without HOST_WALLET is local-only)
    spin.start("starting payment guard");
    await sh("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "guard"]);
    spin.stop(ok("guard up — set HOST_WALLET to your 0.0.x id for paid serving"));

    // 9. sync to backend: region + owner claim (best-effort — serving works regardless)
    if (o.region) {
      try {
        await api(o.gateway, `/api/hosts/${account.address}/meta`, { method: "POST", body: JSON.stringify({ region: o.region }) });
        console.log(ok(`region ${o.region} (self-reported)`));
      } catch (e) {
        console.log(warn(`region sync skipped: ${String((e as Error)?.message ?? e).slice(0, 120)}`));
      }
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
