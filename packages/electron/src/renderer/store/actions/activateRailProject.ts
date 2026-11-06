import type { Store } from 'jotai/vanilla/store';

// The store singleton, not the `store/index` barrel, which would drag every
// renderer atom module in behind it.
import { store } from '@nimbalyst/runtime/store';
import {
  activeWorkspacePathAtom,
  addOpenProjectAtom,
  multiProjectModeAtom,
  openProjectsAtom,
} from '../atoms/openProjects';

function projectNameFor(workspacePath: string): string {
  return workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath;
}

/**
 * Make a project the visible one in this window's rail. Returns false when the
 * switch did not happen.
 *
 * Main finds the window for a project with a rail-aware lookup, so the window
 * that receives an event for Project-A may be showing Project-B. Anything that
 * acts on a specific project (opening a file, a session, a test fixture) has to
 * switch here first instead of acting on whatever project is active.
 *
 * Registering with main before flipping the rail is the part that is easy to
 * get wrong: main only accepts `workspace:set-active` for a path this window
 * has registered, and the rail can have dropped a path that main still
 * considers warm.
 */
export async function activateRailProject(
  workspacePath: string,
  targetStore: Store = store,
): Promise<boolean> {
  if (targetStore.get(activeWorkspacePathAtom) === workspacePath) return true;

  // With the rail off the window renders only the project it opened with
  // (App mirrors the active path into the view only in rail mode). Switching
  // here would move main and every workspace-scoped operation to a project the
  // screen does not show. Callers route to that project's own window instead.
  if (!targetStore.get(multiProjectModeAtom)) {
    console.error('[activateRailProject] project rail is off; not switching this window to', workspacePath);
    return false;
  }

  const alreadyOpen = targetStore
    .get(openProjectsAtom)
    .some((project) => project.path === workspacePath);

  if (!alreadyOpen) {
    try {
      const registration = await window.electronAPI.invoke('workspace:register-additional', {
        workspacePath,
      });
      if (!registration?.success) {
        console.error('[activateRailProject] register-additional failed:', registration?.error);
        return false;
      }
    } catch (error) {
      console.error('[activateRailProject] register-additional threw:', error);
      return false;
    }
  }

  // Writing the atom is what switches the rail; its subscriber dispatches
  // `workspace:set-active` back to main.
  targetStore.set(addOpenProjectAtom, {
    path: workspacePath,
    name: projectNameFor(workspacePath),
    openedAt: Date.now(),
  });

  // `addOpenProjectAtom` silently no-ops once the rail is at its cap.
  if (targetStore.get(activeWorkspacePathAtom) !== workspacePath) {
    console.error('[activateRailProject] could not switch to', workspacePath, '- the project rail is full');
    return false;
  }
  return true;
}
