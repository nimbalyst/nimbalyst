/**
 * Renderer-side implementation of ExtensionFileStorage.
 *
 * Bridges to main process IPC handlers for sandboxed file operations.
 * All file access is confined to the extension's data directory.
 */

import type { ExtensionFileStorage } from '@nimbalyst/runtime';

export class ExtensionFileStorageImpl implements ExtensionFileStorage {
  private basePath: string | null = null;
  private globalBasePath: string | null = null;

  constructor(
    private readonly extensionId: string,
    private readonly workspacePath: string,
  ) {}

  async getBasePath(): Promise<string> {
    if (!this.basePath) {
      this.basePath = await window.electronAPI.invoke('extension:file-storage:get-base-path', {
        extensionId: this.extensionId,
        workspacePath: this.workspacePath,
        scope: 'workspace',
      });
    }
    return this.basePath!;
  }

  async getGlobalBasePath(): Promise<string> {
    if (!this.globalBasePath) {
      this.globalBasePath = await window.electronAPI.invoke('extension:file-storage:get-base-path', {
        extensionId: this.extensionId,
        workspacePath: this.workspacePath,
        scope: 'global',
      });
    }
    return this.globalBasePath!;
  }

  async write(relativePath: string, data: string | Uint8Array): Promise<void> {
    const isString = typeof data === 'string';
    await window.electronAPI.invoke('extension:file-storage:write', {
      extensionId: this.extensionId,
      workspacePath: this.workspacePath,
      relativePath,
      data: isString ? data : Buffer.from(data).toString('base64'),
      encoding: isString ? 'utf-8' : 'base64',
    });
  }

  async readText(relativePath: string): Promise<string> {
    return await window.electronAPI.invoke('extension:file-storage:read-text', {
      extensionId: this.extensionId,
      workspacePath: this.workspacePath,
      relativePath,
    });
  }

  async read(relativePath: string): Promise<Uint8Array> {
    const base64 = await window.electronAPI.invoke('extension:file-storage:read', {
      extensionId: this.extensionId,
      workspacePath: this.workspacePath,
      relativePath,
    });
    // Convert base64 string to Uint8Array in renderer
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async exists(relativePath: string): Promise<boolean> {
    return await window.electronAPI.invoke('extension:file-storage:exists', {
      extensionId: this.extensionId,
      workspacePath: this.workspacePath,
      relativePath,
    });
  }

  async delete(relativePath: string): Promise<void> {
    await window.electronAPI.invoke('extension:file-storage:delete', {
      extensionId: this.extensionId,
      workspacePath: this.workspacePath,
      relativePath,
    });
  }

  async list(relativePath?: string): Promise<string[]> {
    return await window.electronAPI.invoke('extension:file-storage:list', {
      extensionId: this.extensionId,
      workspacePath: this.workspacePath,
      relativePath,
    });
  }

  async getUsage(): Promise<{ usedBytes: number; limitBytes: number }> {
    return await window.electronAPI.invoke('extension:file-storage:usage', {
      extensionId: this.extensionId,
    });
  }
}
