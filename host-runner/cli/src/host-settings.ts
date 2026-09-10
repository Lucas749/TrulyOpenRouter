export interface HostSettings {
  address: `0x${string}`;
  registry: `0x${string}`;
  registeredModelId: string;
  modelId: string;
  modelDigest: `0x${string}`;
  endpoint: string;
  paused: boolean;
  revision: number;
  expiresAt: number;
}

export function hostSettingsMessage(s: HostSettings): string {
  return ["TrulyOpenRouter host settings v1", "chain: 296", `host: ${s.address.toLowerCase()}`, `registry: ${s.registry.toLowerCase()}`,
    `registeredModel: ${s.registeredModelId}`, `model: ${s.modelId}`, `digest: ${s.modelDigest.toLowerCase()}`,
    `endpoint: ${s.endpoint}`, `paused: ${s.paused}`, `revision: ${s.revision}`, `expiresAt: ${s.expiresAt}`].join("\n");
}

export function parseHostSettings(value: unknown, now = Date.now()): HostSettings {
  const s = value as HostSettings | null;
  if (!s || !/^0x[0-9a-fA-F]{40}$/.test(s.address) || !/^0x[0-9a-fA-F]{40}$/.test(s.registry)
    || !/^0x[0-9a-fA-F]{64}$/.test(s.modelDigest) || typeof s.paused !== "boolean"
    || !Number.isSafeInteger(s.revision) || s.revision < 1 || s.revision > 2_000_000_000
    || !Number.isSafeInteger(s.expiresAt) || s.expiresAt < now || s.expiresAt > now + 300_000) throw new Error("Invalid or expired host settings");
  for (const model of [s.registeredModelId, s.modelId]) {
    if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) throw new Error("Invalid model name");
  }
  if (typeof s.endpoint !== "string" || s.endpoint.length > 2048 || /[\s\x00-\x1f]/.test(s.endpoint)) throw new Error("Invalid host endpoint");
  const url = new URL(s.endpoint);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error("Use an HTTP or HTTPS host URL without credentials, query, or fragment");
  return { address: s.address.toLowerCase() as `0x${string}`, registry: s.registry.toLowerCase() as `0x${string}`,
    registeredModelId: s.registeredModelId, modelId: s.modelId, modelDigest: s.modelDigest.toLowerCase() as `0x${string}`,
    endpoint: s.endpoint, paused: s.paused, revision: s.revision, expiresAt: s.expiresAt };
}
