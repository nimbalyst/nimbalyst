import type { TeamProjectSummary } from './TeamService';

export type OrgProjectLocalStatus = 'open' | 'closed' | 'notLocal';

export interface WorkspaceRemoteState {
  workspacePath: string;
  gitRemoteHash: string;
  open: boolean;
}

export interface OrgProjectLocalState extends TeamProjectSummary {
  localStatus: OrgProjectLocalStatus;
  workspacePath: string | null;
}

export function resolveOrgProjectLocalStates(
  projects: readonly TeamProjectSummary[],
  workspaces: readonly WorkspaceRemoteState[],
): OrgProjectLocalState[] {
  const workspaceByHash = new Map<string, WorkspaceRemoteState>();
  for (const workspace of workspaces) {
    const existing = workspaceByHash.get(workspace.gitRemoteHash);
    if (!existing || (!existing.open && workspace.open)) {
      workspaceByHash.set(workspace.gitRemoteHash, workspace);
    }
  }

  return projects.map((project) => {
    const workspace = project.gitRemoteHash
      ? workspaceByHash.get(project.gitRemoteHash)
      : undefined;
    return {
      ...project,
      workspacePath: workspace?.workspacePath ?? null,
      localStatus: workspace
        ? workspace.open ? 'open' : 'closed'
        : 'notLocal',
    };
  });
}

