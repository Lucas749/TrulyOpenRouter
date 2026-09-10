import { createPublicClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, saveConfig } from "./config.js";
import { findHostRegistry } from "./host-registry.js";
import { hostSettingsMessage, parseHostSettings, type HostSettings } from "./host-settings.js";

export async function hostApi(gateway: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`${gateway.replace(/\/+$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Gateway request failed (${response.status})`);
  return data;
}

export async function hostContext(gateway = loadConfig().gateway, signal?: AbortSignal) {
  const local = loadConfig();
  if (!local.hostKey) throw new Error("No host key here. Finish quickstart first.");
  const account = privateKeyToAccount(local.hostKey as `0x${string}`);
  const network = await hostApi(gateway, "/api/config", undefined, signal);
  if (network.chainId !== 296 || !network.rpcUrl || !network.registry) throw new Error("The gateway must provide Hedera testnet chain settings.");
  const publicClient = createPublicClient({ transport: http(network.rpcUrl, { timeout: 15000, retryCount: 1 }) });
  if (await publicClient.getChainId() !== 296) throw new Error("RPC network does not match Hedera testnet.");
  return { gateway, account, network, publicClient };
}

export async function currentHostSettings(gateway?: string, signal?: AbortSignal): Promise<HostSettings> {
  const ctx = await hostContext(gateway, signal);
  if (!ctx.network.hostRuntime) throw new Error("This gateway needs the host controls update before it can change routing settings.");
  const { registry, host } = await findHostRegistry(ctx.publicClient, ctx.network.registry as Address, ctx.network.legacyRegistries ?? [], ctx.account.address);
  if (!host.active || host.stake === 0n) throw new Error("This host is not actively registered. Finish registration before starting services.");
  const record = await hostApi(ctx.gateway, `/api/hosts/${ctx.account.address}/runtime`, undefined, signal);
  const matches = record.registry?.toLowerCase() === registry.toLowerCase() && record.registeredModelId === host.modelId;
  return {
    address: ctx.account.address, registry, registeredModelId: host.modelId,
    modelId: matches ? record.modelId : host.modelId, modelDigest: matches ? record.modelDigest : host.modelDigest,
    endpoint: matches ? record.endpoint : host.endpoint, paused: matches ? record.paused : false,
    revision: Number(record.revision ?? 0), expiresAt: Date.now() + 120000,
  };
}

export async function publishHostSettings(settings: HostSettings, gateway = loadConfig().gateway, signal?: AbortSignal): Promise<HostSettings> {
  const cfg = loadConfig();
  if (!cfg.hostKey) throw new Error("Host key is missing.");
  const account = privateKeyToAccount(cfg.hostKey as `0x${string}`);
  if (settings.address.toLowerCase() !== account.address.toLowerCase()) throw new Error("Host key does not match the settings.");
  const intent = parseHostSettings({ ...settings, revision: settings.revision + 1, expiresAt: Date.now() + 120000 });
  const signature = await account.signMessage({ message: hostSettingsMessage(intent) });
  const result = await hostApi(gateway, `/api/hosts/${account.address}/runtime`, { settings: intent, signature }, signal);
  if (result.revision !== intent.revision || result.address !== intent.address) throw new Error("Gateway did not confirm this settings revision. Refresh host status.");
  saveConfig({ ...loadConfig(), gateway, hostRegistry: settings.registry });
  return intent;
}
