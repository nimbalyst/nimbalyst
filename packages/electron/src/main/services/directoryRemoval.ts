/**
 * Deleting a directory tree from the Electron main process
 *
 * Electron patches `fs` in its main process so that every `*.asar` file
 * reads as a directory. `fs.promises.rm` of a tree holding one never
 * settles, and any Electron project's checkout holds one once its
 * dependencies are installed
 * (`node_modules/electron/dist/resources/default_app.asar`). Electron ships
 * the unpatched module as `original-fs`.
 */

import * as fs from 'fs';
import { createRequire } from 'module';

/** The `fs` module without Electron's asar support; plain `fs` outside Electron */
export function fsWithoutAsar(
  versions: NodeJS.ProcessVersions = process.versions,
  load: (id: string) => unknown = createRequire(import.meta.url)
): typeof fs {
  return versions.electron ? (load('original-fs') as typeof fs) : fs;
}

/**
 * Deletes `target` and everything below it, as `rm -rf` does, without
 * Electron's asar support. Rejects when the delete fails.
 *
 * There is no time limit. A caller that stopped waiting would see the
 * directory still there, report the removal as failed and show the
 * worktree's sessions again, while the delete went on and took whatever was
 * written into the checkout in the meantime. Other git operations on the
 * repository give up waiting for its lock on their own.
 */
export async function removeDirectoryTree(
  target: string,
  { fsModule = fsWithoutAsar() }: { fsModule?: Pick<typeof fs, 'promises'> } = {}
): Promise<void> {
  await fsModule.promises.rm(target, { recursive: true, force: true, maxRetries: 3 });
}
