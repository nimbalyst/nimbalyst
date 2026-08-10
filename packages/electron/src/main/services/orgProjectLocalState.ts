import type { TeamProjectSummary } from './TeamService';

export type OrgProjectLocalStatus = 'open' | 'closed' | 'notLocal';

export interface WorkspaceRemoteState {
  workspacePath: string;
  gitRemoteHash: string;
  open: boolean;
}

/**
 * A workspace that names its project directly, because it has no git remote to
 * be matched by. See `WorkspaceState.localOrgBinding`.
 */
export interface WorkspaceBindingState {
  workspacePath: string;
  teamProjectId: string;
  open: boolean;
}

export interface OrgProjectLocalState extends TeamProjectSummary {
  localStatus: OrgProjectLocalStatus;
  workspacePath: string | null;
}

export function resolveOrgProjectLocalStates(
  projects: readonly TeamProjectSummary[],
  workspaces: readonly WorkspaceRemoteState[],
  boundWorkspaces: readonly WorkspaceBindingState[] = [],
): OrgProjectLocalState[] {
  const workspaceByHash = new Map<string, WorkspaceRemoteState>();
  for (const workspace of workspaces) {
    const existing = workspaceByHash.get(workspace.gitRemoteHash);
    if (!existing || (!existing.open && workspace.open)) {
      workspaceByHash.set(workspace.gitRemoteHash, workspace);
    }
  }

  const workspaceByProject = new Map<string, WorkspaceBindingState>();
  for (const workspace of boundWorkspaces) {
    const existing = workspaceByProject.get(workspace.teamProjectId);
    if (!existing || (!existing.open && workspace.open)) {
      workspaceByProject.set(workspace.teamProjectId, workspace);
    }
  }

  return projects.map((project) => {
    // Remote first, binding second -- the same precedence findTeamForWorkspace
    // uses, so the row and the resolver never disagree about which folder a
    // project is.
    const workspace = (project.gitRemoteHash
      ? workspaceByHash.get(project.gitRemoteHash)
      : undefined)
      ?? (project.teamProjectId
        ? workspaceByProject.get(project.teamProjectId)
        : undefined);
    return {
      ...project,
      workspacePath: workspace?.workspacePath ?? null,
      localStatus: workspace
        ? workspace.open ? 'open' : 'closed'
        : 'notLocal',
    };
  });
}

