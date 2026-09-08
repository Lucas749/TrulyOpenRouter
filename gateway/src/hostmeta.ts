// Self-reported host regions ("eu-central"). Offchain metadata — the registry stays minimal.
// Displayed as self-reported everywhere (never presented as verified geo).
import { db } from "./db.js";

const REGION_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function validRegion(region: unknown): region is string {
  return typeof region === "string" && REGION_RE.test(region);
}

export interface HostMeta {
  setRegion(address: string, region: string): Promise<void>;
  regionOf(address: string): Promise<string | null>;
  distinctRegions(): Promise<string[]>;
  setOwner(address: string, userId: string): Promise<void>;
  ownerOf(address: string): Promise<string | null>;
  hostsOf(userId: string): Promise<string[]>;
}

export class MemoryHostMeta implements HostMeta {
  private regions = new Map<string, string>();
  private owners = new Map<string, string>(); // host -> Privy user id (claimed at link time)

  async setRegion(address: string, region: string): Promise<void> {
    this.regions.set(address.toLowerCase(), region);
  }

  async regionOf(address: string): Promise<string | null> {
    return this.regions.get(address.toLowerCase()) ?? null;
  }

  async distinctRegions(): Promise<string[]> {
    return [...new Set(this.regions.values())];
  }

  async setOwner(address: string, userId: string): Promise<void> {
    this.owners.set(address.toLowerCase(), userId);
  }

  async ownerOf(address: string): Promise<string | null> {
    return this.owners.get(address.toLowerCase()) ?? null;
  }

  async hostsOf(userId: string): Promise<string[]> {
    return [...this.owners.entries()].filter(([, u]) => u === userId).map(([a]) => a);
  }
}

/// @notice Postgres host meta (DATABASE_URL set). Owner claims survive
/// restarts — login-linked dashboards keep working. Same interface as memory.
export class PgHostMeta implements HostMeta {
  constructor(private pool?: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) {}

  private q() {
    return this.pool ?? db();
  }

  async setRegion(address: string, region: string): Promise<void> {
    await this.q().query(
      `INSERT INTO host_meta (address, region) VALUES ($1,$2)
       ON CONFLICT (address) DO UPDATE SET region = EXCLUDED.region`,
      [address.toLowerCase(), region],
    );
  }

  async regionOf(address: string): Promise<string | null> {
    const { rows } = await this.q().query(`SELECT region FROM host_meta WHERE address = $1`, [address.toLowerCase()]);
    return rows[0]?.region ?? null;
  }

  async distinctRegions(): Promise<string[]> {
    const { rows } = await this.q().query(`SELECT DISTINCT region FROM host_meta WHERE region IS NOT NULL`);
    return rows.map((r) => r.region);
  }

  async setOwner(address: string, userId: string): Promise<void> {
    await this.q().query(
      `INSERT INTO host_meta (address, owner_user_id) VALUES ($1,$2)
       ON CONFLICT (address) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id`,
      [address.toLowerCase(), userId],
    );
  }

  async ownerOf(address: string): Promise<string | null> {
    const { rows } = await this.q().query(`SELECT owner_user_id FROM host_meta WHERE address = $1`, [address.toLowerCase()]);
    return rows[0]?.owner_user_id ?? null;
  }

  async hostsOf(userId: string): Promise<string[]> {
    const { rows } = await this.q().query(`SELECT address FROM host_meta WHERE owner_user_id = $1`, [userId]);
    return rows.map((r) => r.address);
  }
}
