import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { activeOrganizations, type OrgChoice } from './defaultOrg';

export function shouldRenderOrgRail(organizations: readonly OrgChoice[]): boolean {
  return activeOrganizations([...organizations]).length >= 2;
}

export function orgConnectionStatus(
  snapshot: TeamInboxSnapshot,
  orgId: string,
): 'connecting' | 'ready' | 'offline' | 'messagingUnavailable' {
  return snapshot.organizations.find((organization) => organization.orgId === orgId)?.status
    ?? (snapshot.status === 'loading' ? 'connecting' : 'offline');
}

export function isOrgConnectionReady(
  snapshot: TeamInboxSnapshot,
  orgId: string,
): boolean {
  return orgConnectionStatus(snapshot, orgId) === 'ready';
}

export function connectionSummary(snapshot: TeamInboxSnapshot): {
  orgCount: number;
  reconnectingCount: number;
  allReady: boolean;
} {
  const orgCount = snapshot.organizations.length;
  const reconnectingCount = snapshot.organizations.filter(
    (organization) => organization.status !== 'ready',
  ).length;
  return {
    orgCount,
    reconnectingCount,
    allReady: orgCount > 0 && reconnectingCount === 0,
  };
}

