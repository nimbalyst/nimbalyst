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

/**
 * Initialize the storage backend with the current workspace path.
 */
export function initializeElectronStorageBackend(workspacePath: string | null): void {
  currentWorkspacePath = workspacePath;

  // Load workspace storage into cache
  if (workspacePath && window.electronAPI) {
    window.electronAPI.invoke('workspace:get-state', workspacePath, 'extensionStorage')
      .then((data) => {
        workspaceCache = data || {};
      })
      .catch((err) => {
        console.error('[ElectronStorageBackend] Failed to load workspace storage:', err);
      });
  }

  // Load global storage into cache
  if (window.electronAPI) {
    window.electronAPI.invoke('app-settings:get', 'extensionStorage')
      .then((data) => {
        globalCache = data || {};
      })
      .catch((err) => {
        console.error('[ElectronStorageBackend] Failed to load global storage:', err);
      });
  }
}

/**
 * Update workspace path when workspace changes.
 */
export function updateWorkspacePath(workspacePath: string | null): void {
  currentWorkspacePath = workspacePath;
  workspaceCache = {};

  if (workspacePath && window.electronAPI) {
    window.electronAPI.invoke('workspace:get-state', workspacePath, 'extensionStorage')
      .then((data) => {
        workspaceCache = data || {};
      })
      .catch((err) => {
        console.error('[ElectronStorageBackend] Failed to load workspace storage:', err);
      });
  }
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
    workspaceCache[key] = value;

    if (!currentWorkspacePath || !window.electronAPI) {
      console.warn('[ElectronStorageBackend] Cannot save workspace storage: no workspace path');
      return;
    }

    try {
      await window.electronAPI.invoke(
        'workspace:update-state',
        currentWorkspacePath,
        'extensionStorage',
        { ...workspaceCache }
      );
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to save workspace storage:', err);
      throw err;
    }
  },

  async deleteWorkspace(key: string): Promise<void> {
    delete workspaceCache[key];

    if (!currentWorkspacePath || !window.electronAPI) {
      return;
    }

    try {
      await window.electronAPI.invoke(
        'workspace:update-state',
        currentWorkspacePath,
        'extensionStorage',
        { ...workspaceCache }
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
    globalCache[key] = value;

    if (!window.electronAPI) {
      console.warn('[ElectronStorageBackend] Cannot save global storage: no electronAPI');
      return;
    }

    try {
      await window.electronAPI.invoke('app-settings:set', 'extensionStorage', { ...globalCache });
    } catch (err) {
      console.error('[ElectronStorageBackend] Failed to save global storage:', err);
      throw err;
    }
  },

  async deleteGlobal(key: string): Promise<void> {
    delete globalCache[key];

    if (!window.electronAPI) {
      return;
    }

    try {
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
    const prefix = `ext:${extensionId}:`;
    const secretPrefix = `nimbalyst:${extensionId}:`;

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
    if (currentWorkspacePath && window.electronAPI) {
      await window.electronAPI.invoke(
        'workspace:update-state',
        currentWorkspacePath,
        'extensionStorage',
        { ...workspaceCache }
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
