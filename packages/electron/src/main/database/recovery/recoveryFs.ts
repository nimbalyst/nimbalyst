/**
 * Filesystem primitives shared by both recovery backend adapters.
 *
 * Small on purpose. The one rule worth stating: nothing in here deletes a
 * database. `removeScratch` is the only removal, it is only ever pointed at a
 * copy this process just created, and the transaction calls
 * `assertCandidateStillPresent` first.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { directorySizeBytes } from '../sqlite/dirSize';

export { directorySizeBytes };

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Recursive directory copy. Used for PGLite stores, which are directories. */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isSymbolicLink()) await fs.symlink(await fs.readlink(from), to);
    else await fs.copyFile(from, to);
  }
}

/** Bytes at a path, whether it is a file or a directory. 0 when absent. */
export async function pathSizeBytes(target: string): Promise<number> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory() ? directorySizeBytes(target) : stat.size;
  } catch {
    return 0;
  }
}

/**
 * The staging copy may only be removed while the artifact it came from is
 * still on disk. If the source has gone, that partial copy is suddenly the
 * only thing left and removing it would be the very mistake this module is
 * here to prevent.
 */
export async function assertCandidateStillPresent(candidatePath: string): Promise<boolean> {
  return pathExists(candidatePath);
}

/** Remove a path this process created. Never called on a live database. */
export async function removeScratch(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * The `-wal` and `-shm` files better-sqlite3 leaves next to a database. A move
 * or a removal that ignores them leaves a stale journal beside a fresh file,
 * which SQLite will happily read.
 */
export function sqliteSidecars(dbFile: string): string[] {
  return [`${dbFile}-wal`, `${dbFile}-shm`];
}

/**
 * Move a SQLite database and any sidecars that exist, all or nothing.
 *
 * The naive version renamed the main file and then the sidecars, so a sidecar
 * rename that failed -- a Windows file lock, a full disk -- reported failure
 * with the main file already at the destination. The caller reads that as "the
 * displacement did not happen", puts nothing back, and reopens against a path
 * with no database at it. Worse, the half-moved shape is the one SQLite will
 * happily open: main file at the destination, WAL holding the newest writes
 * left behind at the source, silently ignored.
 *
 * So every rename that landed is undone before the error propagates, and the
 * caller's "it failed, nothing moved" reading is true again.
 */
export async function moveSqliteDatabase(from: string, to: string): Promise<void> {
  const moved: [string, string][] = [];
  try {
    await fs.rename(from, to);
    moved.push([from, to]);
    for (const suffix of ['-wal', '-shm']) {
      const src = `${from}${suffix}`;
      if (!(await pathExists(src))) continue;
      await fs.rename(src, `${to}${suffix}`);
      moved.push([src, `${to}${suffix}`]);
    }
  } catch (err) {
    for (const [src, dest] of moved.reverse()) {
      try {
        await fs.rename(dest, src);
      } catch {
        // Nothing further to try. Both names are recorded in the recovery
        // journal, so startup can still find whichever copy landed where.
      }
    }
    throw err;
  }
}

/** Remove a SQLite database and any sidecars. Scratch only. */
export async function removeSqliteDatabase(target: string): Promise<void> {
  await fs.rm(target, { force: true });
  for (const sidecar of sqliteSidecars(target)) {
    await fs.rm(sidecar, { force: true });
  }
}

/** Move a PGLite store (a directory). */
export async function moveDirectory(from: string, to: string): Promise<void> {
  await fs.rename(from, to);
}
