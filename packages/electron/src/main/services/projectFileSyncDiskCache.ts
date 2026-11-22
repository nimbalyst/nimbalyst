/**
 * Disk-state cache for project file sync.
 *
 * Every (re)connect announces a manifest of current disk content hashes. Reading
 * and hashing every synced file for that took ~13-17 s per connect on projects
 * with a few thousand files, nearly all of it for files that had not changed.
 * The cache remembers, per file, the hash of the bytes on disk together with the
 * size and mtime they were read at; a file whose size and mtime have not moved
 * reuses that hash instead of being read again.
 *
 * The stamp lives in `project_file_sync_baseline` (disk_hash, disk_size,
 * disk_mtime), next to the last-synced baseline. It is a different fact from
 * the baseline: the baseline is what both sides last agreed on, the stamp is
 * what is on this disk now. A stamp is only persisted for a file that has a
 * baseline row; other files fall back to hashing, which is always correct.
 */

import { database } from '../database/PGLiteDatabaseWorker';
import { logger } from '../utils/logger';

export interface DiskStamp {
  hash: string;
  size: number;
  mtime: number;
}

export interface ScannedFile {
  filePath: string;
  size: number;
  mtime: number;
}

/** A stamp is only trusted when both size and mtime match the scan. */
export function stampMatches(stamp: DiskStamp | undefined, file: { size: number; mtime: number }): stamp is DiskStamp {
  return !!stamp && stamp.size === file.size && stamp.mtime === file.mtime;
}

/** BIGINT may come back as a string on PGLite and as bigint on SQLite. */
function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse the stamp columns of a baseline row; undefined when the row has none. */
export function parseDiskStamp(row: { disk_hash?: unknown; disk_size?: unknown; disk_mtime?: unknown }): DiskStamp | undefined {
  const size = toNumber(row.disk_size);
  const mtime = toNumber(row.disk_mtime);
  if (typeof row.disk_hash !== 'string' || !row.disk_hash || size == null || mtime == null) return undefined;
  return { hash: row.disk_hash, size, mtime };
}

export interface DiskStampRow {
  syncId: string;
  /** The in-memory baseline; only used if the row vanished meanwhile, so the insert recreates the same baseline. */
  baselineHash: string;
  baselineMtime: number;
  stamp: DiskStamp;
}

const ROWS_PER_STATEMENT = 200;

/** Multi-row upsert that only moves the stamp columns of existing baseline rows. */
export function diskStampUpsertSql(rowCount: number): string {
  const values: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const p = i * 8;
    values.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8})`);
  }
  return `INSERT INTO project_file_sync_baseline (project_id, sync_id, content_hash, last_synced_mtime, updated_at, disk_hash, disk_size, disk_mtime)
    VALUES ${values.join(', ')}
    ON CONFLICT (project_id, sync_id) DO UPDATE SET
      disk_hash = EXCLUDED.disk_hash,
      disk_size = EXCLUDED.disk_size,
      disk_mtime = EXCLUDED.disk_mtime`;
}

/** Persist stamps in batches. Best effort: a failure costs one extra rehash later. */
export async function persistDiskStamps(projectId: string, rows: DiskStampRow[]): Promise<void> {
  const now = new Date();
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    const params: unknown[] = [];
    for (const r of chunk) {
      params.push(projectId, r.syncId, r.baselineHash, r.baselineMtime, now, r.stamp.hash, r.stamp.size, r.stamp.mtime);
    }
    try {
      await database.query(diskStampUpsertSql(chunk.length), params);
    } catch (err) {
      logger.main.error(`[ProjectFileSync] Failed to persist ${chunk.length} disk stamps:`, err);
      return;
    }
  }
}
