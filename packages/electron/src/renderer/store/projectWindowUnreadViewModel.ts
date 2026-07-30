import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';

import { inboxUnreadCount } from '../components/TeamMode/orgSidebarViewModel';

export interface ProjectWindowOrgUnread {
  orgId: string;
  orgName: string;
  unreadCount: number;
}

export interface ProjectWindowUnreadSummary {
  totalUnread: number;
  orgs: ProjectWindowOrgUnread[];
}

export function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export function selectProjectWindowUnreadSummary(
  snapshot: TeamInboxSnapshot,
): ProjectWindowUnreadSummary {
  const orgNames = new Map<string, string>();

  for (const org of snapshot.organizations) {
    orgNames.set(org.orgId, org.orgName);
  }

  for (const delivery of snapshot.deliveries) {
    if (!orgNames.has(delivery.orgId)) {
      orgNames.set(delivery.orgId, delivery.orgName);
    }
  }

  const orgs = Array.from(orgNames, ([orgId, orgName]) => ({
    orgId,
    orgName,
    unreadCount: inboxUnreadCount(snapshot, orgId),
  }))
    .filter((org) => org.unreadCount > 0)
    .sort((left, right) => {
      if (right.unreadCount !== left.unreadCount) {
        return right.unreadCount - left.unreadCount;
      }
      return left.orgName.localeCompare(right.orgName, undefined, {
        sensitivity: 'base',
      });
    });

  return {
    totalUnread: orgs.reduce((sum, org) => sum + org.unreadCount, 0),
    orgs,
  };
}

export function selectProjectWindowUnreadTarget(
  summary: ProjectWindowUnreadSummary,
  workspaceOrgId: string | null | undefined,
): string | null {
  if (workspaceOrgId) {
    const workspaceOrg = summary.orgs.find((org) => org.orgId === workspaceOrgId);
    if (workspaceOrg && workspaceOrg.unreadCount > 0) {
      return workspaceOrg.orgId;
    }
  }

  return summary.orgs[0]?.orgId ?? null;
}
