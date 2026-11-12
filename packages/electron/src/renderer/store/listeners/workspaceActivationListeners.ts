import type { Store } from 'jotai/vanilla/store';

// The store singleton, not the `store/index` barrel, which would drag every
// renderer atom module in behind it.
import { store } from '@nimbalyst/runtime/store';
import { activateRailProject } from '../actions/activateRailProject';

interface ActivateProjectPayload {
  workspacePath?: string;
}

/**
 * Installs the renderer-wide subscription for "switch this window to that
 * project", sent by the main process when it reuses an existing window for an
 * open-project request.
 */
export function initWorkspaceActivationListeners(targetStore: Store = store): () => void {
  return window.electronAPI.on(
    'workspace:activate-project',
    (data: ActivateProjectPayload | undefined) => {
      const workspacePath = data?.workspacePath;
      if (!workspacePath) return;
      // Main routes an "open this project" request to the window that already
      // references it, which may be showing a different project
      // (https://github.com/nimbalyst/nimbalyst/issues/1427).
      void activateRailProject(workspacePath, targetStore);
    }
  );
}
