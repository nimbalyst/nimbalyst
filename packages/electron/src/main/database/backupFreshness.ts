import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_FALLBACK_BACKUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Undo the `:` / `.` -> `-` substitution that the backup services apply when
 * naming files. e.g. `2026-06-02T03-04-41-264Z` -> `2026-06-02T03:04:41.264Z`.
 * The date half (before `T`) has no separators to restore.
 */
export function unmangleIsoTimestamp(stamp: string): string {
  const t = stamp.indexOf('T');
  if (t < 0) return stamp;
  const date = stamp.slice(0, t);
  const timeWithMs = stamp.slice(t + 1).replace(/-(\d{3}Z)$/, '.$1');
  return `${date}T${timeWithMs.replace(/-/g, ':')}`;
}

/**
 * Read the most recent `lastSuccessfulBackup` timestamp across both SQLite and
 * PGLite backup metadata files under `userDataPath`. Returns `0` if no valid
 * backup metadata exists.
 */
export function readLatestBackupTimestampMs(
  userDataPath: string,
  onParseError?: (filePath: string, err: unknown) => void,
): number {
  const metadataPaths = [
    path.join(userDataPath, 'sqlite-db.backups', 'backup-metadata.json'),
    path.join(userDataPath, 'db-backups', 'backup-metadata.json'),
  ];

  let lastSuccessMs = 0;
  for (const p of metadataPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        lastSuccessfulBackup?: string | null;
      };
      const stamp = raw.lastSuccessfulBackup;
      if (!stamp) continue;
      const ms = Date.parse(unmangleIsoTimestamp(stamp));
      if (Number.isFinite(ms) && ms > lastSuccessMs) lastSuccessMs = ms;
    } catch (parseErr) {
      onParseError?.(p, parseErr);
    }
  }
  return lastSuccessMs;
}

export interface QuitBackupFreshness {
  skip: boolean;
  ageMs: number | null;
  windowMs: number;
}

/**
 * Decide whether the synchronous quit backup can be skipped because a recent
 * successful backup already exists within the configured periodic backup
 * interval.
 *
 * When `backupIntervalMs <= 0` ("only back up on quit"), the quit backup is
 * never skipped so users who disabled periodic backups still get snapshots.
 */
export function evaluateQuitBackupFreshness(
  userDataPath: string,
  backupIntervalMs: number,
  nowMs: number = Date.now(),
  onParseError?: (filePath: string, err: unknown) => void,
): QuitBackupFreshness {
  if (!Number.isFinite(backupIntervalMs) || backupIntervalMs <= 0) {
    return { skip: false, ageMs: null, windowMs: 0 };
  }
  const lastSuccessMs = readLatestBackupTimestampMs(userDataPath, onParseError);
  if (lastSuccessMs <= 0) {
    return { skip: false, ageMs: null, windowMs: backupIntervalMs };
  }
  const ageMs = Math.max(0, nowMs - lastSuccessMs);
  return {
    skip: ageMs < backupIntervalMs,
    ageMs,
    windowMs: backupIntervalMs,
  };
}
