/**
 * Team members for tracker people fields, resolved from the workspace's org.
 *
 * Returns an empty list when the workspace has no team (or the lookup fails),
 * which is the signal every people editor uses to fall back to free text.
 */

import { useEffect, useState } from 'react';
import type { TeamMemberOption } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';

export async function loadTrackerTeamMembers(workspacePath: string): Promise<TeamMemberOption[]> {
  const teamResult = await window.electronAPI.invoke(
    'team:find-for-workspace',
    workspacePath,
  );
  const orgId = teamResult?.success && teamResult.team?.orgId
    ? String(teamResult.team.orgId)
    : null;
  if (!orgId) return [];

  const membersResult = await window.electronAPI.invoke('team:list-members', orgId);
  return membersResult?.success && Array.isArray(membersResult.members)
    ? membersResult.members
        .filter((member: { email?: unknown }) => typeof member.email === 'string')
        .map((member: { email: string; name?: unknown }) => ({
          email: member.email,
          name: typeof member.name === 'string' ? member.name : undefined,
        }))
    : [];
}

export function useTrackerTeamMembers(workspacePath?: string): TeamMemberOption[] {
  const [teamMembers, setTeamMembers] = useState<TeamMemberOption[]>([]);

  useEffect(() => {
    if (!workspacePath) {
      setTeamMembers((current) => current.length === 0 ? current : []);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const members = await loadTrackerTeamMembers(workspacePath);
        if (cancelled) return;
        setTeamMembers(members);
      } catch {
        if (!cancelled) {
          setTeamMembers((current) => current.length === 0 ? current : []);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  return teamMembers;
}
