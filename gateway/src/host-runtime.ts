import { verifyMessage, type Hex } from "viem";
import { db } from "./db.js";
import { hostSettingsMessage, parseHostSettings, type HostSettings } from "./host-settings.js";
import type { HostInfo } from "./registry.js";

export interface RuntimeRecord extends HostSettings { signature: Hex; updatedAt: number }
export interface HostRuntimeStore {
  get(address: string): Promise<RuntimeRecord | null>;
  list(): Promise<RuntimeRecord[]>;
  put(record: RuntimeRecord): Promise<boolean>;
}
export class MemoryHostRuntime implements HostRuntimeStore {
  private records = new Map<string, RuntimeRecord>();
  async get(address: string) { return this.records.get(address.toLowerCase()) ?? null; }
  async list() { return [...this.records.values()]; }
  async put(record: RuntimeRecord) {
    const previous = this.records.get(record.address.toLowerCase());
    if (record.revision !== (previous?.revision ?? 0) + 1) return false;
    this.records.set(record.address.toLowerCase(), record);
    return true;
  }
}
export class PgHostRuntime implements HostRuntimeStore {
  constructor(private pool?: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }) {}
  private q() { return this.pool ?? db(); }
  async get(address: string) {
    const { rows } = await this.q().query("SELECT settings FROM host_runtime WHERE address=$1", [address.toLowerCase()]);
    return (rows[0]?.settings as RuntimeRecord) ?? null;
  }
  async list() {
    const { rows } = await this.q().query("SELECT settings FROM host_runtime");
    return rows.map(r => r.settings as RuntimeRecord);
  }
  async put(record: RuntimeRecord) {
    const { rows } = await this.q().query(
      `INSERT INTO host_runtime (address, revision, settings)
       SELECT $1, $2, $3::jsonb WHERE $2=1 OR EXISTS (SELECT 1 FROM host_runtime WHERE address=$1 AND revision=$2-1)
       ON CONFLICT (address) DO UPDATE SET revision=EXCLUDED.revision, settings=EXCLUDED.settings
       WHERE host_runtime.revision=EXCLUDED.revision-1 RETURNING address`,
      [record.address.toLowerCase(), record.revision, JSON.stringify(record)],
    );
    return rows.length === 1;
  }
}
export class HostSettingsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function authorizeHostSettings(value: unknown, signature: unknown, now = Date.now()): Promise<RuntimeRecord> {
  let settings: HostSettings;
  try { settings = parseHostSettings(value, now); }
  catch (error) { throw new HostSettingsError(400, (error as Error).message); }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new HostSettingsError(403, "A host-key signature is required");
  const valid = await verifyMessage({ address: settings.address, message: hostSettingsMessage(settings), signature: signature as Hex }).catch(() => false);
  if (!valid) throw new HostSettingsError(403, "Host signature does not match these settings");
  return { ...settings, signature: signature as Hex, updatedAt: now };
}

export function applyHostSettings(host: HostInfo, record?: RuntimeRecord): HostInfo {
  if (!record || record.registry.toLowerCase() !== host.registry?.toLowerCase() || record.registeredModelId !== host.modelId) return host;
  return { ...host, registeredModelId: host.modelId, registeredEndpoint: host.endpoint, paused: record.paused,
    endpoint: record.endpoint, modelId: record.modelId, modelDigest: record.modelDigest, active: host.active && !record.paused };
}
