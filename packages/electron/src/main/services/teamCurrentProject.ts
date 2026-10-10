import type { TeamDetails } from "./TeamService";

/**
 * The team project a workspace's Pages show: the one its team resolved to, or,
 * for a team listed without one (an older directory), the only project in the
 * registry -- the one case that needs no guess. Null otherwise; the Pages
 * session then takes the primary from the team snapshot.
 *
 * The docs session's scope (`resolveIndexConfig`) and the agent page tools'
 * `project` routing both use this, so "the current project" means the same
 * project to both.
 */
export function currentTeamProjectId(team: Pick<TeamDetails, "teamProjectId" | "projects">): string | null {
  return team.teamProjectId
    ?? (team.projects?.length === 1 ? team.projects[0].teamProjectId : null);
}
