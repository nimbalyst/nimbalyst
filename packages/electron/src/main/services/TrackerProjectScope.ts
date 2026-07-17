/** Stable project scope shared by tracker read receipts and tracker personal state. */

import { createHash } from 'crypto';
import { findTeamForWorkspace } from './TeamService';
import { getNormalizedGitRemote } from '../utils/gitUtils';
import { resolveProjectPath } from '../utils/workspaceDetection';

export interface TrackerProjectScope {
  scope: string;
  /** Local-only scopes must never be sent over personal sync. */
  syncable: boolean;
}

interface TrackerProjectScopeDependencies {
  findTeamForWorkspace: (
    workspacePath: string,
    precomputedRemote?: string,
  ) => Promise<{ orgId: string; teamProjectId?: string | null } | null>;
  getNormalizedGitRemote: typeof getNormalizedGitRemote;
  resolveProjectPath: typeof resolveProjectPath;
}

export function createTrackerProjectScopeResolver(deps: TrackerProjectScopeDependencies) {
  return async (workspacePath: string): Promise<TrackerProjectScope> => {
    const normalizedRemote = await deps.getNormalizedGitRemote(workspacePath);
    const team = await deps.findTeamForWorkspace(workspacePath, normalizedRemote ?? undefined);
    if (team?.orgId && team.teamProjectId) {
      return {
        scope: `org:${team.orgId}:tracker:${team.teamProjectId}`,
        syncable: true,
      };
    }

    // The normalized-remote hash is already the personal project-index and D1
    // discovery identity. It remains stable across paths, worktrees, and devices.
    if (normalizedRemote) {
      return {
        scope: `git:${createHash('sha256').update(normalizedRemote).digest('hex')}`,
        syncable: true,
      };
    }

    // A workspace with neither a mapped project nor a git remote has no honest
    // cross-device identity. Keep its state local and never put this path on wire.
    return {
      scope: `local:${deps.resolveProjectPath(workspacePath)}`,
      syncable: false,
    };
  };
}

export const resolveTrackerProjectScope = createTrackerProjectScopeResolver({
  findTeamForWorkspace,
  getNormalizedGitRemote,
  resolveProjectPath,
});
