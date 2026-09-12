import { getOrgMeta, getRules } from "./members";
import { syncOrgRules } from "./gateway-admin";

// Push org rules + member handles to gateway pre-flight enforcement.
// Shared by direct-set and intent-approve paths. Returns sync status.
export async function syncRulesToGateway(orgId: string): Promise<{ synced: boolean; error: string | null }> {
  const meta = await getOrgMeta(orgId);
  const rules = await getRules(orgId);
  const handles = (meta?.members ?? [])
    .filter((m) => m.status === "active")
    .flatMap((m) => [`wallet:${m.walletAddress.toLowerCase()}`, ...(m.keyPrefix ? [`key:${m.keyPrefix}`] : [])]);
  try {
    await syncOrgRules(orgId, {
      dailyCapCredits: rules.dailyCapCredits ?? null,
      allowedModels: rules.allowedModels ?? null,
      allowedRegions: rules.allowedRegions ?? null,
      requireVerified: rules.requireVerified ?? false,
      agentExceptions: rules.agentExceptions ?? true,
      rateLimitPerMin: rules.rateLimitPerMin ?? null,
      pinnedHosts: rules.pinnedHosts ?? null,
      handles,
    });
    return { synced: true, error: null };
  } catch (e: any) {
    return { synced: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}
