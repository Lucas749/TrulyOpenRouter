import { getOrgMeta, type Member, type OrgMeta } from "./members";
import { syncTeamSnapshot } from "./gateway-admin";

// Mirror team membership to the gateway, which bills team wallets and checks
// approval authority. Changes that reduce authority (removal, demotion, lower
// allowances) push a preview of the resulting state BEFORE persisting, so the
// gateway never keeps honoring access the team already revoked. Every change
// then pushes the stored state again, which also repairs a failed persist.

export type TeamSync = { synced: boolean; skipped: boolean; error: string | null };

export async function syncTeamToGateway(orgId: string, preview?: (members: Member[], meta: OrgMeta) => { members: Member[]; defaultAllowanceCredits?: number }): Promise<TeamSync> {
  const meta = await getOrgMeta(orgId);
  if (!meta) return { synced: false, skipped: false, error: "team not found" };
  const next = preview ? preview(meta.members.map((m) => ({ ...m })), meta) : { members: meta.members, defaultAllowanceCredits: meta.defaultAllowanceCredits };
  try {
    const r = await syncTeamSnapshot({ orgId, name: meta.displayName, defaultAllowanceCredits: next.defaultAllowanceCredits, members: next.members });
    return { synced: r === "synced", skipped: r === "skipped", error: null };
  } catch (e: unknown) {
    return { synced: false, skipped: false, error: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

/// @notice Preview helper: the same members with one row replaced.
export function withMember(did: string, patch: Partial<Member>) {
  return (members: Member[], meta: OrgMeta) => ({
    members: members.map((m) => (m.did === did ? { ...m, ...patch } : m)),
    defaultAllowanceCredits: meta.defaultAllowanceCredits,
  });
}
