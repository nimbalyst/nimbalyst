import { store } from '@nimbalyst/runtime/store';
import {
  activeWorkspacePathAtom,
  closeOpenProjectAtom,
  getReplacementOpenProjectPath,
  openProjectsAtom,
  addOpenProjectAtom,
  type OpenProject,
} from '../store/atoms/openProjects';
import { globalSessionActivityAtom } from '../store/atoms/sessionActivity';
import { MAX_OPEN_PROJECT_TABS } from '../../shared/projectTabs';
import type {
  ProjectTabDragPayload,
  ProjectTabMutation,
} from '../../shared/projectTabs';

export interface ProjectTabActionResult {
  success: boolean;
  error?: string;
}

function projectFromPath(workspacePath: string): OpenProject {
  return {
    path: workspacePath,
    name: workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath,
    openedAt: Date.now(),
  };
}

/** Apply a main-owned cross-window mutation without re-registering/removing services. */
export async function applyProjectTabMutation(mutation: ProjectTabMutation): Promise<void> {
  if (mutation.kind === 'add') {
    store.set(addOpenProjectAtom, projectFromPath(mutation.workspacePath));
    return;
  }

  const currentlyOpen = store.get(openProjectsAtom);
  const wasActive = store.get(activeWorkspacePathAtom) === mutation.workspacePath;
  if (currentlyOpen.some((project) => project.path === mutation.workspacePath)) {
    store.set(closeOpenProjectAtom, mutation.workspacePath);
  }

  const remaining = store.get(openProjectsAtom);
  if (
    wasActive
    && mutation.replacementWorkspacePath
    && remaining.some((project) => project.path === mutation.replacementWorkspacePath)
  ) {
    store.set(activeWorkspacePathAtom, mutation.replacementWorkspacePath);
  }

  if (mutation.closeWindowWhenEmpty && remaining.length === 0) {
    await window.electronAPI?.invoke?.('workspace:close-rail-window');
  }
}

/** Ask main to atomically move a source tab into this renderer's window. */
export async function moveProjectTabToCurrentWindow(
  payload: ProjectTabDragPayload,
): Promise<ProjectTabActionResult> {
  if (!window.electronAPI?.invoke) {
    return { success: false, error: 'electronAPI is required' };
  }
  try {
    const result = await window.electronAPI.invoke('workspace:move-project-tab', {
      dragId: payload.dragId,
    });
    return result?.success
      ? { success: true }
      : { success: false, error: result?.error || 'Unable to move project tab' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function openProjectTab(workspacePath: string): Promise<ProjectTabActionResult> {
  if (!workspacePath || !window.electronAPI?.invoke) {
    return { success: false, error: 'workspacePath and electronAPI are required' };
  }

  const openProjects = store.get(openProjectsAtom);
  const alreadyOpen = openProjects.some((project) => project.path === workspacePath);
  if (!alreadyOpen && openProjects.length >= MAX_OPEN_PROJECT_TABS) {
    return { success: false, error: `You can have at most ${MAX_OPEN_PROJECT_TABS} project tabs open.` };
  }

  try {
    const registration = await window.electronAPI.invoke('workspace:register-additional', { workspacePath });
    if (!registration?.success) {
      return { success: false, error: registration?.error || 'Unable to register project tab' };
    }
    store.set(addOpenProjectAtom, projectFromPath(workspacePath));
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function finalizeCloseProjectTab(workspacePath: string): Promise<ProjectTabActionResult> {
  if (!window.electronAPI?.invoke) {
    return { success: false, error: 'electronAPI is required' };
  }
  const projects = store.get(openProjectsAtom);
  if (!projects.some((project) => project.path === workspacePath)) {
    return { success: false, error: 'Project tab is not open' };
  }

  const replacementWorkspacePath = getReplacementOpenProjectPath(projects, workspacePath);
  const wasLast = projects.length === 1;

  try {
    const result = await window.electronAPI.invoke('workspace:unregister-additional', {
      workspacePath,
      replacementWorkspacePath,
    });
    if (!result?.success) {
      return { success: false, error: result?.error || 'Unable to unregister project tab' };
    }
    // Only remove the visible tab after the main process accepts the close.
    // This avoids leaving the renderer and the service registry out of sync
    // when an IPC validation or lifecycle check fails.
    store.set(closeOpenProjectAtom, workspacePath);
    if (wasLast) {
      await window.electronAPI.invoke('workspace:close-rail-window');
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function closeProjectTab(
  workspacePath: string,
  options: { confirmStreaming?: boolean } = {},
): Promise<ProjectTabActionResult> {
  const project = store.get(openProjectsAtom).find((entry) => entry.path === workspacePath);
  if (!project) return { success: false, error: 'Project tab is not open' };

  if (options.confirmStreaming !== false) {
    const streaming = store.get(globalSessionActivityAtom).get(workspacePath)?.streaming.size ?? 0;
    if (streaming > 0) {
      const proceed = window.confirm(
        `${project.name} has ${streaming} streaming session${streaming === 1 ? '' : 's'}. Close anyway? Sessions will be paused.`,
      );
      if (!proceed) return { success: false, error: 'cancelled' };
    }
  }

  return finalizeCloseProjectTab(workspacePath);
}

export async function closeActiveProjectTab(): Promise<ProjectTabActionResult> {
  const activePath = store.get(activeWorkspacePathAtom);
  if (!activePath) return { success: false, error: 'No active project tab' };
  return closeProjectTab(activePath);
}

export async function detachProjectTab(
  workspacePath: string,
  position?: { screenX: number; screenY: number },
): Promise<ProjectTabActionResult> {
  try {
    const result = await window.electronAPI?.invoke?.('workspace:detach-project-tab', {
      workspacePath,
      position,
    });
    if (!result?.success) {
      return { success: false, error: result?.error || 'Unable to detach project tab' };
    }
    // The destination window now references the project, so removing it from
    // this window cannot tear down shared services or interrupt sessions.
    return finalizeCloseProjectTab(workspacePath);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
