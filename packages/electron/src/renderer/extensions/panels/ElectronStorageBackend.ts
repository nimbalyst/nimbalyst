/**
 * Electron Storage Backend
 *
 * Implements the StorageBackend interface for Electron.
 * - Workspace storage: Uses IPC to workspace-settings store
 * - Global storage: Uses IPC to app-settings store
 * - Secret storage: Uses Electron's safeStorage for encryption
 */

import type { StorageBackend } from '@nimbalyst/runtime';

// Cache for synchronous access
let workspaceCache: Record<string, unknown> = {};
let globalCache: Record<string, unknown> = {};
let currentWorkspacePath: string | null = null;
let workspaceHydration: Promise<void> = Promise.resolve();
let globalHydration: Promise<void> = Promise.resolve();
let workspaceHydrationGeneration = 0;
let globalHydrationGeneration = 0;
let hydratedWorkspaceGeneration: number | null = null;

const STORAGE_HYDRATED_EVENT = 'nimbalyst:extension-storage-hydrated';

interface WorkspaceState {
  extensionStorage?: Record<string, unknown>;
}

function notifyStorageHydrated(workspacePath: string | null): void {
  if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(STORAGE_HYDRATED_EVENT, {
    detail: { workspacePath },
  }));
}

function hydrateWorkspaceCache(workspacePath: string | null): Promise<void> {
  const generation = ++workspaceHydrationGeneration;
  hydratedWorkspaceGeneration = null;
  workspaceCache = {};

  if (!workspacePath || !window.electronAPI) {
    hydratedWorkspaceGeneration = generation;
    return Promise.resolve();
  }

  return window.electronAPI.invoke('workspace:get-state', workspacePath)
    .then((state: WorkspaceState | undefined) => {
      if (generation !== workspaceHydrationGeneration || workspacePath !== currentWorkspacePath) return;
      workspaceCache = state?.extensionStorage ?? {};
      hydratedWorkspaceGeneration = generation;
    })
    .catch((err) => {
      if (generation !== workspaceHydrationGeneration || workspacePath !== currentWorkspacePath) return;
      console.error('[ElectronStorageBackend] Failed to load workspace storage:', err);
    });
}

function hydrateGlobalCache(): Promise<void> {
  const generation = ++globalHydrationGeneration;
  globalCache = {};

  if (!window.electronAPI) {
    return Promise.resolve();
  }

  return window.electronAPI.invoke('app-settings:get', 'extensionStorage')
    .then((data) => {
      if (generation !== globalHydrationGeneration) return;
      globalCache = data || {};
    })
    .catch((err) => {
      if (generation !== globalHydrationGeneration) return;
      console.error('[ElectronStorageBackend] Failed to load global storage:', err);
    });
}

/**
 * Initialize the storage backend with the current workspace path.
 */
export function initializeElectronStorageBackend(workspacePath: string | null): Promise<void> {
  currentWorkspacePath = workspacePath;
  workspaceHydration = hydrateWorkspaceCache(workspacePath);
  globalHydration = hydrateGlobalCache();
  const generation = workspaceHydrationGeneration;

  return Promise.all([workspaceHydration, globalHydration]).then(() => {
    if (generation === workspaceHydrationGeneration && workspacePath === currentWorkspacePath) {
      notifyStorageHydrated(workspacePath);
    }
  });
}

/**
 * Update workspace path when workspace changes.
 */
export function updateWorkspacePath(workspacePath: string | null): Promise<void> {
  currentWorkspacePath = workspacePath;
  workspaceHydration = hydrateWorkspaceCache(workspacePath);
  const generation = workspaceHydrationGeneration;
  return workspaceHydration.then(() => {
    if (generation === workspaceHydrationGeneration && workspacePath === currentWorkspacePath) {
      notifyStorageHydrated(workspacePath);
    }
  });
}

/**
 * Electron implementation of StorageBackend.
 */
export const electronStorageBackend: StorageBackend = {
  // ============ WORKSPACE STORAGE ============

  getWorkspace<T>(key: string): T | undefined {
    return workspaceCache[key] as T | undefined;
  },

  async setWorkspace<T>(key: string, value: T): Promise<void> {
    const workspacePath = currentWorkspacePath;
    const hydrationGeneration = workspaceHydrationGeneration;
    if (!workspacePath || !window.electronAPI) {
      console.warn('[ElectronStorageBackend] Cannot save workspace storage: no workspace path');
      return;
    }

    try {
      await workspaceHydration;
      if (workspacePath !== currentWorkspacePath) return;
      if (hydratedWorkspaceGeneration !== hydrationGeneration) {
        throw new Error('Cannot save workspace storage before it has loaded successfully');
      }
      workspaceCache[key] = value;
      // Same-workspace windows remain last-write-wins because this IPC replaces
      // the complete extensionStorage blob; cross-window merging is out of scope.
      await window.electronAPI.invoke(
        'workspace:update-state',
        workspacePath,
        { extensionStorage: { ...workspaceCache } },
      );
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to save workspace storage:', err);
      throw err;
    }
  },

  async deleteWorkspace(key: string): Promise<void> {
    const workspacePath = currentWorkspacePath;
    const hydrationGeneration = workspaceHydrationGeneration;
    if (!workspacePath || !window.electronAPI) {
      return;
    }

    try {
      await workspaceHydration;
      if (workspacePath !== currentWorkspacePath) return;
      if (hydratedWorkspaceGeneration !== hydrationGeneration) {
        throw new Error('Cannot delete workspace storage before it has loaded successfully');
      }
      delete workspaceCache[key];
      await window.electronAPI.invoke(
        'workspace:update-state',
        workspacePath,
        { extensionStorage: { ...workspaceCache } },
      );
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to delete workspace storage:', err);
      throw err;
    }
  },

  // ============ GLOBAL STORAGE ============

  getGlobal<T>(key: string): T | undefined {
    return globalCache[key] as T | undefined;
  },

  async setGlobal<T>(key: string, value: T): Promise<void> {
    if (!window.electronAPI) {
      console.warn('[ElectronStorageBackend] Cannot save global storage: no electronAPI');
      return;
    }

    try {
      await globalHydration;
      globalCache[key] = value;
      await window.electronAPI.invoke('app-settings:set', 'extensionStorage', { ...globalCache });
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to save global storage:', err);
      throw err;
    }
  },

  async deleteGlobal(key: string): Promise<void> {
    if (!window.electronAPI) {
      return;
    }

    try {
      await globalHydration;
      delete globalCache[key];
      await window.electronAPI.invoke('app-settings:set', 'extensionStorage', { ...globalCache });
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to delete global storage:', err);
      throw err;
    }
  },

  // ============ SECRET STORAGE ============

  async getSecret(key: string): Promise<string | undefined> {
    if (!window.electronAPI) {
      console.warn('[ElectronStorageBackend] Cannot get secret: no electronAPI');
      return undefined;
    }

    try {
      const result = await window.electronAPI.invoke('secrets:get', key);
      return result || undefined;
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to get secret:', err);
      return undefined;
    }
  },

  async setSecret(key: string, value: string): Promise<void> {
    if (!window.electronAPI) {
      console.warn('[ElectronStorageBackend] Cannot set secret: no electronAPI');
      return;
    }

    try {
      await window.electronAPI.invoke('secrets:set', key, value);
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to set secret:', err);
      throw err;
    }
  },

  async deleteSecret(key: string): Promise<void> {
    if (!window.electronAPI) {
      return;
    }

    try {
      await window.electronAPI.invoke('secrets:delete', key);
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to delete secret:', err);
      throw err;
    }
  },

  // ============ CLEANUP ============

  async deleteAllForExtension(extensionId: string): Promise<void> {
    const workspacePath = currentWorkspacePath;
    const hydrationGeneration = workspaceHydrationGeneration;
    const prefix = `ext:${extensionId}:`;
    const secretPrefix = `nimbalyst:${extensionId}:`;

    await Promise.all([workspaceHydration, globalHydration]);
    if (workspacePath !== currentWorkspacePath) return;
    if (workspacePath && hydratedWorkspaceGeneration !== hydrationGeneration) {
      throw new Error('Cannot delete extension workspace storage before it has loaded successfully');
    }

    // Clean workspace storage
    for (const key of Object.keys(workspaceCache)) {
      if (key.startsWith(prefix)) {
        delete workspaceCache[key];
      }
    }

    // Clean global storage
    for (const key of Object.keys(globalCache)) {
      if (key.startsWith(prefix)) {
        delete globalCache[key];
      }
    }

    // Save cleaned caches
    if (workspacePath && window.electronAPI) {
      await window.electronAPI.invoke(
        'workspace:update-state',
        workspacePath,
        { extensionStorage: { ...workspaceCache } },
      );
    }

    if (window.electronAPI) {
      await window.electronAPI.invoke('app-settings:set', 'extensionStorage', { ...globalCache });
    }

    // Note: Secrets cleanup would need a way to list all secrets for the extension
    // For now, we rely on extensions to clean up their own secrets on uninstall
    console.log(`[ElectronStorageBackend] Cleaned up storage for extension: ${extensionId}`);
  },
};
