/**
 * Pure resolution of a workspace's git-remote hash to a team + project.
 *
 * Epic H3 P0/A: an org can now hold MULTIPLE projects, each rooted at its own
 * git remote and named by its own tracker-room routing key (`teamProjectId`).
 * `listTeams` returns, per team, the PRIMARY project's `gitRemoteHash` /
 * `teamProjectId` plus the full `projects` registry. This resolver decides which
 * (org, teamProjectId) a workspace belongs to by matching its remote hash:
 *   1. the team whose PRIMARY project matches (fast path), or
 *   2. a SECONDARY project in some team's registry.
 *
 * Extracted from TeamService so it can be unit-tested without that module's
 * Electron import graph.
 */

/** One project in an org's registry (subset of the server's list-projects row). */
export interface ResolverProject {
  projectId: string;
  teamProjectId: string;
  gitRemoteHash: string | null;
  slug: string | null;
  name: string | null;
}

/** The team fields the resolver needs (structural subset of TeamDetails). */
export interface ResolverTeam {
  orgId: string;
  name: string;
  gitRemoteHash: string | null;
  teamProjectId?: string | null;
  membershipType?: string;
  projects?: ResolverProject[];
}

/**
 * Resolve a remote hash to the team it belongs to. Returns the matched team
 * (possibly with its `teamProjectId` / `name` overridden to point at a secondary
 * project), or null if no active team owns the remote.
 *
 * Only ACTIVE members are considered -- never auto-join invited/pending teams.
 */
export function resolveTeamForRemoteHash<T extends ResolverTeam>(
  teams: T[],
  remoteHash: string,
): T | null {
  const activeTeams = teams.filter(
    t => !t.membershipType || t.membershipType === 'active_member',
  );

  // Fast path: the remote matches a team's PRIMARY project (team.gitRemoteHash
  // mirrors the primary project's hash).
  const primaryMatch = activeTeams.find(t => t.gitRemoteHash === remoteHash);
  if (primaryMatch) {
    return primaryMatch;
  }

  // The remote may belong to a SECONDARY project added to an org. Scan each
  // team's registry for a matching project and pin the result to that project's
  // tracker room. Skip the primary (already covered above).
  for (const team of activeTeams) {
    const proj = team.projects?.find(p => p.gitRemoteHash === remoteHash);
    if (proj && proj.teamProjectId && proj.teamProjectId !== team.teamProjectId) {
      return {
        ...team,
        name: proj.name || proj.slug || team.name,
        gitRemoteHash: remoteHash,
        teamProjectId: proj.teamProjectId,
      };
    }
  }

  return null;
}
