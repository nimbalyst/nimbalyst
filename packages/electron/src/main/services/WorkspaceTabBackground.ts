import { getMcpConfigService } from '../mcpConfigServiceRef';
import { anyWindowReferencesWorkspace } from '../window/windowState';
import { logger } from '../utils/logger';
import { autoMatchTeamForWorkspace } from './TeamService';
import { updateTrackerSchemaWorkspace } from './TrackerSchemaService';
import { initializeTrackerSync } from './TrackerSyncManager';

// A workspace can be referenced by several windows, and an active tab can be
// selected repeatedly. Keep background bootstrap process-wide and tied to the
// lifetime of the last workspace reference rather than to tab activation.
const initializedWorkspaces = new Map<string, symbol>();

/** Start per-workspace background services once while the path is referenced. */
export function initializeWorkspaceTabBackground(workspacePath: string): void {
  if (initializedWorkspaces.has(workspacePath)) return;

  const lifecycleToken = Symbol(workspacePath);
  initializedWorkspaces.set(workspacePath, lifecycleToken);

  setTimeout(() => {
    // A close followed by a quick reopen gets a new token. The stale deferred
    // callback must not initialize a second set of watchers for that reopen.
    if (initializedWorkspaces.get(workspacePath) !== lifecycleToken) return;

    // The user may close a just-opened tab before this deferred work runs.
    // Do not resurrect watchers or sync for an unreferenced workspace.
    if (!anyWindowReferencesWorkspace(workspacePath)) {
      initializedWorkspaces.delete(workspacePath);
      return;
    }

    try {
      getMcpConfigService()?.startWatchingWorkspaceConfig(workspacePath);
    } catch (error) {
      logger.main.error('[ProjectTabs] Failed to watch workspace MCP config:', workspacePath, error);
    }

    void autoMatchTeamForWorkspace(workspacePath).catch((error) => {
      logger.main.warn('[ProjectTabs] Failed to match workspace team:', workspacePath, error);
    });
    void initializeTrackerSync(workspacePath).catch((error) => {
      logger.main.warn('[ProjectTabs] Failed to initialize tracker sync:', workspacePath, error);
    });
  }, 0);
}

/** Update only the process-global context that follows the visible project. */
export function activateWorkspaceTabContext(workspacePath: string): void {
  updateTrackerSchemaWorkspace(workspacePath);
}

/** Allow a workspace to initialize again after its final reference closes. */
export function releaseWorkspaceTabBackground(workspacePath: string): void {
  initializedWorkspaces.delete(workspacePath);
}
