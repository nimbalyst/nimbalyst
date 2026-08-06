import { describe, expect, it } from 'vitest';

import {
  resolveOrgProjectLocalStates,
  type WorkspaceRemoteState,
} from '../orgProjectLocalState';
import type { TeamProjectSummary } from '../TeamService';

function project(
  projectId: string,
  gitRemoteHash: string | null,
): TeamProjectSummary {
  return {
    projectId,
    teamProjectId: `team-${projectId}`,
    name: projectId,
    slug: projectId,
    gitRemoteHash,
  };
}

describe('resolveOrgProjectLocalStates', () => {
  it('maps org projects to open, closed, and not-local workspace states', () => {
    const projects = [
      project('open-project', 'hash-open'),
      project('closed-project', 'hash-closed'),
      project('remote-only-project', 'hash-remote'),
      project('unlinked-project', null),
    ];
    const workspaces: WorkspaceRemoteState[] = [
      { workspacePath: '/workspace/closed', gitRemoteHash: 'hash-closed', open: false },
      { workspacePath: '/workspace/open', gitRemoteHash: 'hash-open', open: true },
    ];

    expect(resolveOrgProjectLocalStates(projects, workspaces)).toMatchObject([
      {
        projectId: 'open-project',
        localStatus: 'open',
        workspacePath: '/workspace/open',
      },
      {
        projectId: 'closed-project',
        localStatus: 'closed',
        workspacePath: '/workspace/closed',
      },
      {
        projectId: 'remote-only-project',
        localStatus: 'notLocal',
        workspacePath: null,
      },
      {
        projectId: 'unlinked-project',
        localStatus: 'notLocal',
        workspacePath: null,
      },
    ]);
  });

  it('prefers an open workspace when duplicate remote hashes exist', () => {
    const projects = [project('project-a', 'hash-a')];
    const workspaces: WorkspaceRemoteState[] = [
      { workspacePath: '/workspace/closed', gitRemoteHash: 'hash-a', open: false },
      { workspacePath: '/workspace/open', gitRemoteHash: 'hash-a', open: true },
    ];

    expect(resolveOrgProjectLocalStates(projects, workspaces)[0]).toMatchObject({
      localStatus: 'open',
      workspacePath: '/workspace/open',
    });
  });
});

