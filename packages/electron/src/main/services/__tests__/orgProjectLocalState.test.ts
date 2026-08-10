import { describe, expect, it } from 'vitest';

import {
  resolveOrgProjectLocalStates,
  type WorkspaceBindingState,
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

  // A folder attached through the shared-project flow has no remote to be
  // matched by, so without the binding pass it reports "not local" even while
  // the user is looking at it.
  it('resolves a remote-less project through the workspace bound to it', () => {
    const projects = [project('notes', null)];
    const bound: WorkspaceBindingState[] = [
      { workspacePath: '/workspace/notes', teamProjectId: 'team-notes', open: true },
    ];

    expect(resolveOrgProjectLocalStates(projects, [], bound)[0]).toMatchObject({
      localStatus: 'open',
      workspacePath: '/workspace/notes',
    });
  });

  it('lets a git remote match win over a binding for the same project', () => {
    const projects = [project('widgets', 'hash-widgets')];
    const workspaces: WorkspaceRemoteState[] = [
      { workspacePath: '/workspace/cloned', gitRemoteHash: 'hash-widgets', open: false },
    ];
    const bound: WorkspaceBindingState[] = [
      { workspacePath: '/workspace/bound', teamProjectId: 'team-widgets', open: true },
    ];

    expect(resolveOrgProjectLocalStates(projects, workspaces, bound)[0]).toMatchObject({
      workspacePath: '/workspace/cloned',
    });
  });
});

