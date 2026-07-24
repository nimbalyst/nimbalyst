/**
 * Extension Storage
 *
 * Provides namespaced storage for extensions with three tiers:
 * - Workspace storage: Per-project settings
 * - Global storage: Shared across all projects
 * - Secret storage: Secure storage for credentials (system keychain)
 *
 * All keys are automatically namespaced by extension ID to prevent
 * extensions from accessing each other's data.
 */

import type { ExtensionStorage } from './types';

/**
 * Storage backend interface.
 * Platform-specific implementations provide the actual storage.
 */
export interface StorageBackend {
  /**
   * Get a value from workspace storage.
   * @param key Namespaced key (ext:extensionId:userKey)
   */
  getWorkspace<T>(key: string): T | undefined;

  /**
   * Set a value in workspace storage.
   * @param key Namespaced key (ext:extensionId:userKey)
   * @param value Value to store
   */
  setWorkspace<T>(key: string, value: T): Promise<void>;

  /**
   * Delete a value from workspace storage.
   * @param key Namespaced key
   */
  deleteWorkspace(key: string): Promise<void>;

  /**
   * Get a value from global storage.
   * @param key Namespaced key (ext:extensionId:userKey)
   */
  getGlobal<T>(key: string): T | undefined;

  /**
   * Set a value in global storage.
   * @param key Namespaced key (ext:extensionId:userKey)
   * @param value Value to store
   */
  setGlobal<T>(key: string, value: T): Promise<void>;

  /**
   * Delete a value from global storage.
   * @param key Namespaced key
   */
  deleteGlobal(key: string): Promise<void>;

  /**
   * Get a secret from secure storage.
   * @param key Namespaced key (nimbalyst:extensionId:userKey)
   */
  getSecret(key: string): Promise<string | undefined>;

  /**
   * Set a secret in secure storage.
   * @param key Namespaced key (nimbalyst:extensionId:userKey)
   * @param value Secret value
   */
  setSecret(key: string, value: string): Promise<void>;

  /**
   * Delete a secret from secure storage.
   * @param key Namespaced key
   */
  deleteSecret(key: string): Promise<void>;

  /**
   * Delete all storage for an extension (cleanup on uninstall).
   * @param extensionId Extension ID to clean up
   */
  deleteAllForExtension?(extensionId: string): Promise<void>;
}

// Global storage backend instance
let storageBackend: StorageBackend | null = null;

/**
 * Set the storage backend.
 * Called during app initialization with platform-specific implementation.
 */
export function setStorageBackend(backend: StorageBackend): void {
  storageBackend = backend;
}

/**
 * Get the storage backend.
 * Throws if not initialized.
 */
export function getStorageBackend(): StorageBackend {
  if (!storageBackend) {
    throw new Error(
      'Storage backend not initialized. Call setStorageBackend() during app initialization.'
    );
  }
  return storageBackend;
}

/**
 * Create a namespaced storage service for an extension.
 *
 * @param extensionId Extension ID for namespacing
 * @returns ExtensionStorage instance scoped to this extension
 */
export function createExtensionStorage(extensionId: string): ExtensionStorage {
  const backend = getStorageBackend();

  // Namespace helpers
  const workspaceKey = (key: string) => `ext:${extensionId}:${key}`;
  const globalKey = (key: string) => `ext:${extensionId}:${key}`;
  const secretKey = (key: string) => `nimbalyst:${extensionId}:${key}`;

  return {
    // Workspace storage
    get<T>(key: string): T | undefined {
      return backend.getWorkspace<T>(workspaceKey(key));
    },

    async set<T>(key: string, value: T): Promise<void> {
      await backend.setWorkspace(workspaceKey(key), value);
    },

    async delete(key: string): Promise<void> {
      await backend.deleteWorkspace(workspaceKey(key));
    },

    // Global storage
    getGlobal<T>(key: string): T | undefined {
      return backend.getGlobal<T>(globalKey(key));
    },

    async setGlobal<T>(key: string, value: T): Promise<void> {
      await backend.setGlobal(globalKey(key), value);
    },

    async deleteGlobal(key: string): Promise<void> {
      await backend.deleteGlobal(globalKey(key));
    },

    // Secret storage
    async getSecret(key: string): Promise<string | undefined> {
      return backend.getSecret(secretKey(key));
    },

    async setSecret(key: string, value: string): Promise<void> {
      await backend.setSecret(secretKey(key), value);
    },

    async deleteSecret(key: string): Promise<void> {
      await backend.deleteSecret(secretKey(key));
    },
  };
}

/**
 * Clean up all storage for an extension.
 * Called when an extension is uninstalled.
 *
 * @param extensionId Extension ID to clean up
 */
export async function cleanupExtensionStorage(extensionId: string): Promise<void> {
  const backend = getStorageBackend();

  if (backend.deleteAllForExtension) {
    await backend.deleteAllForExtension(extensionId);
  } else {
    console.warn(
      `[ExtensionStorage] Storage backend does not support deleteAllForExtension. ` +
      `Storage for ${extensionId} may not be fully cleaned up.`
    );
  }
}
