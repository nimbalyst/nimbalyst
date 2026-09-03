import type { Store } from 'jotai/vanilla/store';

// The store singleton, not the `store/index` barrel, which would drag every
// renderer atom module in behind it.
import { store } from '@nimbalyst/runtime/store';
import {
  activeWorkspacePathAtom,
  addOpenProjectAtom,
  openProjectsAtom,
} from '../atoms/openProjects';

interface ActivateProjectPayload {
  workspacePath?: string;
}

function projectNameFor(workspacePath: string): string {
  return workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath;
}

/**
 * Make a project the visible one because main asked us to.
 *
 * Main routes an "open this project" request to the window that already
 * references it, which may be showing a different project entirely — a window
 * created for Project-A is still that window after the user switches it to
 * Project-B. Focusing it alone left the wrong project on screen
 * (https://github.com/nimbalyst/nimbalyst/issues/1427), so main follows the
 * focus with this event and the switch happens here.
 *
 * Registering with main before flipping the rail is the part that is easy to
 * get wrong: main only accepts `workspace:set-active` for a path this window
 * has registered, and the rail can have dropped a path that main still
 * considers warm. `sessionNotificationNavigation` opens with the same two
 * steps for the same reason.
 */
async function activateProject(targetStore: Store, workspacePath: string): Promise<void> {
  if (targetStore.get(activeWorkspacePathAtom) === workspacePath) return;

  const alreadyOpen = targetStore
    .get(openProjectsAtom)
    .some((project) => project.path === workspacePath);

  if (!alreadyOpen) {
    try {
      const registration = await window.electronAPI.invoke('workspace:register-additional', {
        workspacePath,
      });
      if (!registration?.success) {
        console.error('[workspaceActivation] register-additional failed:', registration?.error);
        return;
      }
    } catch (error) {
      console.error('[workspaceActivation] register-additional threw:', error);
      return;
    }
  }

  // Writing the atom is what switches the rail; its subscriber dispatches
  // `workspace:set-active` back to main.
  targetStore.set(addOpenProjectAtom, {
    path: workspacePath,
    name: projectNameFor(workspacePath),
    openedAt: Date.now(),
  });

  // `addOpenProjectAtom` silently no-ops once the rail is at its cap, which
  // would leave the user back at the silent failure this event exists to fix.
  if (targetStore.get(activeWorkspacePathAtom) !== workspacePath) {
    console.error(
      '[workspaceActivation] could not switch to',
      workspacePath,
      '- the project rail is full'
    );
  }
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
      void activateProject(targetStore, workspacePath);
    }
  );
}
