/**
 * Project file-system surface handed to custom editors via `EditorHost.fs`.
 *
 * Lives in `services/` rather than inside TabEditor.tsx because `onChanged`
 * subscribes to IPC. Component files must not do that (docs/IPC_LISTENERS.md) --
 * even when, as here, the subscription is correctly scoped and disposed. It is
 * NOT a singleton: each editor that calls `onChanged` gets its own subscription
 * and disposes it when the editor unmounts.
 */

import type { EditorHostFileSystem, ProjectFileWriteReceipt } from '@nimbalyst/runtime';

interface ProjectFileSystemHostOptions {
  /** Refresh the currently open file after a write lands, so the editor doesn't show stale content. */
  onAfterWrite: (receipt: ProjectFileWriteReceipt) => Promise<void>;
}

export function createProjectFileSystemHost(
  options: ProjectFileSystemHostOptions
): EditorHostFileSystem {
  return {
    read: (paths: string[]) => window.electronAPI.invoke('project-fs:read', paths),

    write: async (edit) => {
      const receipt = await window.electronAPI.invoke('project-fs:write', edit) as ProjectFileWriteReceipt;
      await options.onAfterWrite(receipt);
      return receipt;
    },

    onChanged: (callback: (paths: string[]) => void) => {
      // Two sources: changes made on disk by anything else, and writes routed
      // through this host.
      const unsubscribeDisk = window.electronAPI.onFileChangedOnDisk(
        (data: { path: string }) => callback([data.path])
      );
      const unsubscribeWrite = window.electronAPI.on(
        'project-fs:changed',
        (receipt: ProjectFileWriteReceipt) => {
          callback(receipt.files.map((entry) => entry.path));
        }
      );

      return () => {
        unsubscribeDisk();
        unsubscribeWrite();
      };
    },
  };
}
