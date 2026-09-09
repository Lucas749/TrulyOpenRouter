import { db } from "./db.js";

// Org-level rules synced from web (mirror of team org_rules). Pre-flight only:
// model allowlists + daily org ceilings. Member caps (429 quota_exceeded) stay
// separate; the vault debit stays the final backstop.

export interface OrgRule {
  orgId: string;
  dailyCapCredits: number | null; // null = unlimited
  allowedModels: string[] | null; // null = all models
  allowedRegions: string[] | null; // geo/region slugs, null = all regions
  requireVerified: boolean; // only hosts passing model checks
  rateLimitPerMin: number | null; // calls/min across member handles, null = unlimited
  pinnedHosts: string[] | null; // exact host addresses, null = any host
  handles: string[]; // key:<prefix> + wallet:<addr> identifying member spend
}

export interface OrgRuleStore {
  set(rule: OrgRule): Promise<void>;
  get(orgId: string): Promise<OrgRule | null>;
  orgsForHandle(handle: string): Promise<OrgRule[]>;
}

const clean = (r: OrgRule): OrgRule => ({
  orgId: r.orgId,
  dailyCapCredits: r.dailyCapCredits ?? null,
  allowedModels: r.allowedModels ?? null,
  allowedRegions: r.allowedRegions ?? null,
  requireVerified: !!r.requireVerified,
  rateLimitPerMin: r.rateLimitPerMin ?? null,
  pinnedHosts: r.pinnedHosts ?? null,
  // Handles compare case-insensitively downstream — normalize once, here.
  handles: (r.handles ?? []).map((h) => h.toLowerCase()),
});

export class MemoryOrgRules implements OrgRuleStore {
  private rules = new Map<string, OrgRule>();

  async set(rule: OrgRule): Promise<void> {
    if (!rule.orgId) throw new Error("orgId required");
    this.rules.set(rule.orgId, clean(rule));
  }

  async get(orgId: string): Promise<OrgRule | null> {
    return this.rules.get(orgId) ?? null;
  }

  async orgsForHandle(handle: string): Promise<OrgRule[]> {
    const h = handle.toLowerCase();
    return [...this.rules.values()].filter((r) => r.handles.some((x) => x.toLowerCase() === h));
  }
}

/// @notice Postgres org rules (DATABASE_URL set). Same interface as memory.
export class PgOrgRules implements OrgRuleStore {
  constructor(private pool?: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) {}

  private q() {
    return this.pool ?? db();
  }

  async set(rule: OrgRule): Promise<void> {
    if (!rule.orgId) throw new Error("orgId required");
    const c = clean(rule);
    await this.q().query(
      `INSERT INTO org_rules (org_id, daily_cap, allowed_models, allowed_regions, require_verified, rate_limit_per_min, pinned_hosts, handles)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_id) DO UPDATE SET daily_cap = EXCLUDED.daily_cap,
         allowed_models = EXCLUDED.allowed_models, allowed_regions = EXCLUDED.allowed_regions,
         require_verified = EXCLUDED.require_verified, rate_limit_per_min = EXCLUDED.rate_limit_per_min,
         pinned_hosts = EXCLUDED.pinned_hosts, handles = EXCLUDED.handles`,
      [c.orgId, c.dailyCapCredits, c.allowedModels ? JSON.stringify(c.allowedModels) : null,
        c.allowedRegions ? JSON.stringify(c.allowedRegions) : null, c.requireVerified,
        c.rateLimitPerMin, c.pinnedHosts ? JSON.stringify(c.pinnedHosts) : null, JSON.stringify(c.handles)],
    );
  }

  async get(orgId: string): Promise<OrgRule | null> {
    const { rows } = await this.q().query(`SELECT * FROM org_rules WHERE org_id = $1`, [orgId]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      orgId: r.org_id,
      dailyCapCredits: r.daily_cap != null ? Number(r.daily_cap) : null,
      allowedModels: r.allowed_models == null ? null : typeof r.allowed_models === "string" ? JSON.parse(r.allowed_models) : r.allowed_models,
      allowedRegions: r.allowed_regions == null ? null : typeof r.allowed_regions === "string" ? JSON.parse(r.allowed_regions) : r.allowed_regions,
      requireVerified: !!r.require_verified,
      rateLimitPerMin: r.rate_limit_per_min != null ? Number(r.rate_limit_per_min) : null,
      pinnedHosts: r.pinned_hosts == null ? null : typeof r.pinned_hosts === "string" ? JSON.parse(r.pinned_hosts) : r.pinned_hosts,
      handles: typeof r.handles === "string" ? JSON.parse(r.handles) : (r.handles ?? []),
    };
  }

  async orgsForHandle(handle: string): Promise<OrgRule[]> {
    // Lower-compared so rows written before the write-time normalization still match.
    const { rows } = await this.q().query(
      `SELECT * FROM org_rules WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(handles) h WHERE lower(h) = lower($1))`,
      [handle],
    );
    return rows.map((r) => ({
      orgId: r.org_id,
      dailyCapCredits: r.daily_cap != null ? Number(r.daily_cap) : null,
      allowedModels: r.allowed_models == null ? null : typeof r.allowed_models === "string" ? JSON.parse(r.allowed_models) : r.allowed_models,
      allowedRegions: r.allowed_regions == null ? null : typeof r.allowed_regions === "string" ? JSON.parse(r.allowed_regions) : r.allowed_regions,
      requireVerified: !!r.require_verified,
      rateLimitPerMin: r.rate_limit_per_min != null ? Number(r.rate_limit_per_min) : null,
      pinnedHosts: r.pinned_hosts == null ? null : typeof r.pinned_hosts === "string" ? JSON.parse(r.pinned_hosts) : r.pinned_hosts,
      handles: typeof r.handles === "string" ? JSON.parse(r.handles) : (r.handles ?? []),
    }));
  }
}
