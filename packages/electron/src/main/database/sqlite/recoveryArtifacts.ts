/**
 * Leftover PGLite directories that record something happening to a user's
 * database, found by a single scan of userData at launch.
 *
 *   - `pglite-db.migrated-*` — a completed migration preserved the old store.
 *     Gates retiring the PGLite reader code.
 *   - `pglite-db.backup-*`   — the worker decided the database was corrupt and
 *     renamed it aside (`worker.js`). Until this was reported there was no
 *     fleet signal for it at all, so an established install could be silently
 *     running on an empty database and nothing upstream would know (#1347).
 *
 * Every filesystem error is swallowed: this feeds telemetry gauges, and none of
 * them should be able to fail a launch because a directory went away mid-scan.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dirSizeBytes } from './dirSize';

export const MIGRATED_DIR_PREFIX = 'pglite-db.migrated-';
export const CORRUPTION_BACKUP_DIR_PREFIX = 'pglite-db.backup-';
export const ROLLING_BACKUP_DIR = 'db-backups';
/**
 * The three rolling slots, by role. Named rather than positional because
 * `DatabaseBackupService` rotates between them and reads them back by role --
 * indexing into the array below would let a reorder silently swap which
 * directory is "current".
 */
export const ROLLING_BACKUP_DIRNAMES = {
  current: 'pglite-db.backup-current',
  previous: 'pglite-db.backup-previous',
  oldest: 'pglite-db.backup-oldest',
} as const;
/** The same three slots, newest to oldest, for scanning. */
export const ROLLING_BACKUP_NAMES = [
  ROLLING_BACKUP_DIRNAMES.current,
  ROLLING_BACKUP_DIRNAMES.previous,
  ROLLING_BACKUP_DIRNAMES.oldest,
] as const;
export const TEMP_BACKUP_DIR_PREFIX = 'temp-backup-';
/** Where `SQLiteBackupService` keeps its rolling copies, and what it calls them. */
export const SQLITE_ROLLING_BACKUP_DIR = 'sqlite-db.backups';
export const SQLITE_ROLLING_BACKUP_NAMES = [
  'nimbalyst.backup-current.sqlite',
  'nimbalyst.backup-previous.sqlite',
  'nimbalyst.backup-oldest.sqlite',
] as const;
/**
 * Copies an interrupted recovery leaves behind, minted by
 * `RecoveryBackendAdapter.recoveryPathFor`: `pglite-db.displaced-<ts>` and
 * `sqlite-db/nimbalyst.pre-restore-<ts>.sqlite`, among others.
 *
 * They are full databases, and on the launch after an interrupted recovery they
 * may be the ONLY full database. The failure dialog could not see them, so an
 * install whose live store had been displaced got "Nimbalyst cannot continue
 * without the database" and a Quit button, while the message the log had just
 * written said every copy was still on disk. It was -- under a name the dialog
 * did not scan for.
 */
export const RECOVERY_COPY_INFIXES = ['.displaced-', '.pre-restore-', '.recovery-staging-'] as const;

export type BackupEntryClassification =
  | 'rolling-backup'
  | 'corruption-artifact'
  | 'temp-backup'
  | 'unrelated';

/**
 * Classify a backup entry by both its name and containing directory. The
 * location is part of the identity: rolling backups live under `db-backups/`,
 * while same-prefix corruption artifacts live at the userData root.
 */
export function classifyBackupEntry(
  containingDirectory: string,
  entryName: string,
): BackupEntryClassification {
  if (path.basename(path.resolve(containingDirectory)) === ROLLING_BACKUP_DIR) {
    if (ROLLING_BACKUP_NAMES.some((name) => name === entryName)) return 'rolling-backup';
    if (entryName.startsWith(TEMP_BACKUP_DIR_PREFIX)) return 'temp-backup';
    return 'unrelated';
  }
  if (entryName.startsWith(CORRUPTION_BACKUP_DIR_PREFIX)) return 'corruption-artifact';
  return 'unrelated';
}

export interface RecoveryArtifacts {
  /** Preserved pre-migration stores, newest name last (timestamps sort lexically). */
  migratedDirs: string[];
  /** Databases the worker renamed aside as corrupt, newest name last. */
  corruptionBackupDirs: string[];
}

export function findRecoveryArtifacts(userDataPath: string): RecoveryArtifacts {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(userDataPath);
  } catch {
    return { migratedDirs: [], corruptionBackupDirs: [] };
  }
  const migratedDirs: string[] = [];
  const corruptionBackupDirs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(MIGRATED_DIR_PREFIX)) migratedDirs.push(entry);
    else if (classifyBackupEntry(userDataPath, entry) === 'corruption-artifact') {
      corruptionBackupDirs.push(entry);
    }
  }
  migratedDirs.sort();
  corruptionBackupDirs.sort();
  return { migratedDirs, corruptionBackupDirs };
}

/**
 * Bytes held by the largest renamed-aside database. This is the number that
 * says whether a user has data waiting to be restored: a large value next to a
 * near-empty live `pglite-db/` is the fingerprint of a silent wipe.
 */
export function largestDirBytes(userDataPath: string, dirNames: string[]): number {
  let largest = 0;
  for (const name of dirNames) {
    const bytes = dirSizeBytes(path.join(userDataPath, name));
    if (bytes > largest) largest = bytes;
  }
  return largest;
}

export interface RestorableBackup {
  /** Absolute path, so the failure dialog can name something the user can find. */
  path: string;
  /** Bare directory or file name. */
  name: string;
  bytes: number;
}

/**
 * Every copy of the database still on disk, richest first.
 *
 * **Richest, not newest.** This used to return slot order — `current`,
 * `previous`, `oldest`, then the corruption artifacts — and the failure dialog
 * restored `backups[0]` and quit. So an install whose `current` slot held a
 * small, structurally-valid copy of nothing (the #1347 shape: a database that
 * lost its contents and was then backed up on schedule) restored that copy,
 * failed, quit, and did the same on every subsequent launch, while a `previous`
 * holding months of history was never considered. Both backup services already
 * rank by size for exactly this reason; the dialog was the one caller that did
 * not, which made it the one caller that could not recover.
 *
 * Size is a proxy and does not have to be a perfect one: the recovery
 * transaction fully verifies whichever copy is chosen and refuses an empty or
 * damaged one, so a wrong first guess falls through to the next.
 *
 * Both backends are scanned. A SQLite install that fails to start has its
 * copies under `sqlite-db.backups/`, and a scanner that only knew the PGLite
 * names reported "nothing recoverable" and quit on an install with three
 * healthy backups.
 *
 * Empty entries are excluded — offering a user a 0-byte "backup" during a
 * failed launch is worse than saying nothing.
 */
export function findRestorableBackups(userDataPath: string): RestorableBackup[] {
  const found: RestorableBackup[] = [];
  const consider = (dir: string, name: string) => {
    const full = path.join(dir, name);
    const bytes = dirSizeBytes(full);
    if (bytes > 0) found.push({ path: full, name, bytes });
  };
  const rollingDir = path.join(userDataPath, ROLLING_BACKUP_DIR);
  for (const name of ROLLING_BACKUP_NAMES) consider(rollingDir, name);
  const sqliteRollingDir = path.join(userDataPath, SQLITE_ROLLING_BACKUP_DIR);
  for (const name of SQLITE_ROLLING_BACKUP_NAMES) consider(sqliteRollingDir, name);
  const { corruptionBackupDirs } = findRecoveryArtifacts(userDataPath);
  for (const name of [...corruptionBackupDirs].reverse()) consider(userDataPath, name);
  for (const [dir, base] of [
    [userDataPath, 'pglite-db'],
    [path.join(userDataPath, 'sqlite-db'), 'nimbalyst'],
  ] as const) {
    for (const name of recoveryCopyNames(dir, base)) consider(dir, name);
  }
  // Discovery order breaks ties, so equal-sized copies still prefer the newer
  // slot and the rolling backups still come before the corruption artifacts.
  return found
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.bytes - a.entry.bytes) || (a.index - b.index))
    .map(({ entry }) => entry);
}

/** Newest last, so the tie-break in `findRestorableBackups` prefers the newest. */
function recoveryCopyNames(dir: string, base: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => {
        if (!entry.startsWith(base)) return false;
        const rest = entry.slice(base.length);
        return RECOVERY_COPY_INFIXES.some((infix) => rest.startsWith(infix));
      })
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * How many projects this install has settings for, read straight from the
 * electron-store JSON rather than through `Store` so it works from the SQLite
 * worker thread, which has no electron bindings.
 *
 * This is deliberately a fact about the install rather than about the
 * database: it is how a migration can tell "this store has no sessions because
 * the app is new" apart from "this store has no sessions because it is not the
 * user's store" (NIM-3632).
 */
export function countConfiguredProjects(userDataPath: string): number {
  const fromWorkspaces = countJsonKeys(path.join(userDataPath, 'workspace-settings.json'));
  if (fromWorkspaces > 0) return fromWorkspaces;
  try {
    const raw = fs.readFileSync(path.join(userDataPath, 'app-settings.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { recent?: { workspaces?: unknown[] } };
    return Array.isArray(parsed.recent?.workspaces) ? parsed.recent.workspaces.length : 0;
  } catch {
    return 0;
  }
}

function countJsonKeys(filePath: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).length;
    }
  } catch {
    // Missing or unparseable settings mean no evidence, which is permissive.
  }
  return 0;
}

/** Compact size for display in a plain-text dialog. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
