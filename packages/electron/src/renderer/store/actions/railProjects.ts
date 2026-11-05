/**
 * Open a project in the current window's multi-project rail.
 *
 * Shared by the rail's own "+" menu and the Cmd+Shift+P Projects pane so both
 * register the project with main the same way and respect the same cap.
 * Callers show any UI (the cap warning); these helpers only report outcomes.
 */

import type { createStore } from 'jotai';
import {
  addOpenProjectAtom,
  activeWorkspacePathAtom,
  closeOpenProjectAtom,
  isOpenProjectsAtCapAtom,
  multiProjectModeAtom,
  openProjectsAtom,
  type OpenProject,
} from '../atoms/openProjects';

type JotaiStore = ReturnType<typeof createStore>;

export const PROJECT_LIMIT_WARNING = {
  title: 'Project limit reached',
  message: 'The project limit is eight per window. Close a project or enable Allow unlimited projects in Settings > Advanced.',
};

export type AddProjectToRailResult = 'added' | 'at-cap' | 'failed';

/**
 * Register `workspacePath` as an additional project of this window and make it
 * the active rail project. A project already in the rail is just activated.
 */
export async function addProjectToRail(
  jotaiStore: JotaiStore,
  workspacePath: string,
): Promise<AddProjectToRailResult> {
  const alreadyInRail = jotaiStore.get(openProjectsAtom).some(p => p.path === workspacePath);
  if (alreadyInRail) {
    jotaiStore.set(activeWorkspacePathAtom, workspacePath);
    return 'added';
  }
  if (jotaiStore.get(isOpenProjectsAtCapAtom)) return 'at-cap';

  try {
    const reg = await window.electronAPI.invoke('workspace:register-additional', { workspacePath });
    if (!reg?.success) {
      console.error('[railProjects] register-additional failed:', reg?.error);
      return 'failed';
    }

    const project: OpenProject = {
      path: workspacePath,
      name: workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath,
      openedAt: Date.now(),
    };
    // `addOpenProjectAtom` flips `activeWorkspacePathAtom` to this path;
    // the atom subscriber dispatches `workspace:set-active` to main.
    if (!jotaiStore.set(addOpenProjectAtom, project)) {
      // The limit can change in another window while registration is pending.
      await window.electronAPI.invoke('workspace:unregister-additional', { workspacePath });
      return 'at-cap';
    }
    return 'added';
  } catch (err) {
    console.error('[railProjects] addProjectToRail failed:', err);
    return 'failed';
  }
}

export type SwitchToProjectResult = AddProjectToRailResult | 'opened-window';

/**
 * Project-switcher selection. In multi-project mode a project already in this
 * rail, or not open in any window, opens in this window's rail; a project open
 * in another window focuses that window. Single-project mode always goes
 * through main, which focuses the existing window or opens a new one.
 */
export async function switchToProject(
  jotaiStore: JotaiStore,
  workspacePath: string,
  isOpenInAnyWindow: boolean,
): Promise<SwitchToProjectResult> {
  const inThisRail = jotaiStore.get(openProjectsAtom).some(p => p.path === workspacePath);
  if (jotaiStore.get(multiProjectModeAtom) && (inThisRail || !isOpenInAnyWindow)) {
    return addProjectToRail(jotaiStore, workspacePath);
  }
  await window.electronAPI.workspaceManager.openWorkspace(workspacePath);
  return 'opened-window';
}

/**
 * Take a project out of this window's rail and release its main-process
 * registration. Closing the last project closes the window, so the app can
 * fall back to its project-selection flow. Callers confirm first if needed.
 */
export async function removeProjectFromRail(jotaiStore: JotaiStore, workspacePath: string): Promise<void> {
  const projects = jotaiStore.get(openProjectsAtom);
  if (!projects.some(p => p.path === workspacePath)) return;
  const wasLast = projects.length <= 1;

  jotaiStore.set(closeOpenProjectAtom, workspacePath);

  try {
    await window.electronAPI?.invoke?.('workspace:unregister-additional', { workspacePath });
  } catch (err) {
    console.error('[railProjects] unregister-additional failed:', err);
  }

  if (wasLast) {
    try {
      await window.electronAPI?.invoke?.('workspace:close-rail-window');
    } catch (err) {
      console.error('[railProjects] close-rail-window failed:', err);
    }
  }
}
