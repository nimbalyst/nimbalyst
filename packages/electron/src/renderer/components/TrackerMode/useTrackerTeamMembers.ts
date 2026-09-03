/**
 * Team members for tracker people fields, resolved from the workspace's org.
 *
 * Returns an empty list when the workspace has no team (or the lookup fails),
 * which is the signal every people editor uses to fall back to free text.
 */

import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { TeamMemberOption } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';
import { stytchIsSignedInAtom } from '../../store/atoms/stytchAuth';
import { projectOrgRevisionAtom } from '../../store/atoms/orgScope';
import { organizationDirectoryAtom } from '../../store/atoms/settingsDomains';

/** The team a workspace belongs to, as far as ownership is concerned. */
export interface TrackerTeam {
  orgId: string;
  name: string;
}

/**
 * The team whose trackers this workspace can carry, or null.
 *
 * A pending or invited membership is deliberately not a team yet: nothing is
 * shared until the invite is accepted, so showing ownership sections for it
 * would promise a split that does not exist.
 */
export async function findTrackerTeam(workspacePath: string): Promise<TrackerTeam | null> {
  const teamResult = await window.electronAPI.invoke('team:find-for-workspace', workspacePath);
  const team = teamResult?.success ? teamResult.team : null;
  if (!team?.orgId) return null;
  if (team.membershipType !== undefined && team.membershipType !== 'active_member') return null;
  return { orgId: String(team.orgId), name: typeof team.name === 'string' ? team.name : '' };
}

export async function listTrackerTeamMembers(orgId: string): Promise<TeamMemberOption[]> {
  const membersResult = await window.electronAPI.invoke('team:list-members', orgId);
  return membersResult?.success && Array.isArray(membersResult.members)
    ? membersResult.members
        .filter((member: { email?: unknown }) => typeof member.email === 'string')
        .map((member: { memberId?: unknown; email: string; name?: unknown }) => ({
          memberId: typeof member.memberId === 'string' ? member.memberId : undefined,
          email: member.email,
          name: typeof member.name === 'string' ? member.name : undefined,
        }))
    : [];
}

export async function loadTrackerTeamMembers(workspacePath: string): Promise<TeamMemberOption[]> {
  const team = await findTrackerTeam(workspacePath);
  return team ? listTrackerTeamMembers(team.orgId) : [];
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

export interface TrackerTeamOwnership {
  /** Null means solo: no sections, no ownership language anywhere. */
  team: TrackerTeam | null;
  members: TeamMemberOption[];
}

const NO_TEAM: TrackerTeamOwnership = { team: null, members: [] };

/**
 * Backoff for re-asking after a "no team" answer. `findTeamForWorkspace`
 * reports several TRANSIENT conditions the same way it reports a genuinely
 * solo workspace — not authenticated yet, team list not loaded yet, the git
 * remote momentarily unreadable — and the renderer cannot tell them apart from
 * the answer. Enumerating the causes as atom signals kept missing one, so a
 * null answer is treated as provisional and re-asked a bounded number of times.
 * The call is single-flighted in main, and a found team stops the cycle.
 */
const NO_TEAM_RETRY_DELAYS_MS = [500, 1500, 3000, 6000, 10000];

/**
 * The team name and roster behind the sidebar's ownership sections. One lookup
 * pair for both, so the sections and the people fields don't each fetch the
 * roster.
 *
 * A single fetch on mount is NOT enough, and getting this wrong is silent.
 * `findTeamForWorkspace` returns `null` both when this workspace genuinely has
 * no team AND when the answer is merely not available yet — it returns early if
 * the app is not authenticated, and it resolves against the cached team list,
 * which is loaded asynchronously after sign-in. Tracker mode mounts during app
 * startup, squarely inside that window, so a lookup that runs once and keeps
 * its answer caches "solo" for the life of the window: a team member's
 * ownership sections silently never appear. That is not hypothetical — it was
 * observed live, with the whole unit suite green.
 *
 * So the lookup is skipped while auth is unknown, a "no team" answer is
 * re-asked on a bounded backoff (see {@link NO_TEAM_RETRY_DELAYS_MS}), and it
 * re-runs whenever the inputs it depends on become known:
 *  - `stytchIsSignedInAtom` — signed out is a definitive "no team"; signing in
 *    is the first moment a lookup can succeed.
 *  - `organizationDirectoryAtom` — the loaded team list `findTeamForWorkspace`
 *    resolves against. Auth alone is too early; this is when the answer exists.
 *  - `projectOrgRevisionAtom` — the workspace's org binding changed (e.g. an
 *    org created later in the life of this window).
 */
export function useTrackerTeamOwnership(workspacePath?: string): TrackerTeamOwnership {
  const [ownership, setOwnership] = useState<TrackerTeamOwnership>(NO_TEAM);
  // null = the initial auth fetch has not answered yet.
  const signedIn = useAtomValue(stytchIsSignedInAtom);
  const projectOrgRevision = useAtomValue(projectOrgRevisionAtom);
  // A stable key, so re-resolving keys off which orgs are known, not identity.
  const orgDirectoryKey = useAtomValue(organizationDirectoryAtom)
    .map((entry) => entry.orgId)
    .join(',');

  useEffect(() => {
    // Never conclude "solo" over an unfinished auth lookup.
    if (signedIn === null) return;
    if (!workspacePath || signedIn === false) {
      setOwnership((current) => (current.team === null ? current : NO_TEAM));
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTeam = () => setOwnership((current) => (current.team === null ? current : NO_TEAM));

    const attempt = async (index: number): Promise<void> => {
      let team: TrackerTeam | null = null;
      try {
        team = await findTrackerTeam(workspacePath);
      } catch {
        team = null;
      }
      if (cancelled) return;

      if (!team) {
        clearTeam();
        if (index < NO_TEAM_RETRY_DELAYS_MS.length) {
          retryTimer = setTimeout(() => { void attempt(index + 1); }, NO_TEAM_RETRY_DELAYS_MS[index]);
        }
        return;
      }

      // Paint the section as soon as the team is known. The roster only
      // decorates the header, so a slow or failing member lookup must not hold
      // the whole ownership grammar back.
      setOwnership({ team, members: [] });
      const members = await listTrackerTeamMembers(team.orgId).catch(() => []);
      if (!cancelled) setOwnership({ team, members });
    };

    void attempt(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [workspacePath, signedIn, projectOrgRevision, orgDirectoryKey]);

  return ownership;
}
