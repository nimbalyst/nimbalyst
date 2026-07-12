import {
  isTrackerNavigationEntry,
  type TrackerNavigationEntry,
} from '@nimbalyst/runtime/sync';
import { getDatabase } from '../../database/initialize';
import { logger } from '../../utils/logger';
import type { TypeDefDb } from './trackerTypeDefStore';

interface NavigationRow {
  entry_id: string;
  payload: string | TrackerNavigationEntry;
  sync_id?: number | string | null;
}

function parsePayload(raw: string | TrackerNavigationEntry): TrackerNavigationEntry | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return isTrackerNavigationEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function listTrackerNavigationEntries(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<TrackerNavigationEntry[]> {
  if (!workspace) return [];
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return [];
    const result = await db.query(
      `SELECT entry_id, payload FROM tracker_type_navigation
       WHERE workspace = $1 AND deleted_at IS NULL`,
      [workspace],
    ) as { rows?: NavigationRow[] } | undefined;
    return (result?.rows ?? []).flatMap((row) => {
      const entry = parsePayload(row.payload);
      return entry ? [entry] : [];
    });
  } catch (err) {
    logger.main.warn('[trackerNavigationStore] list failed:', err);
    return [];
  }
}

export async function upsertTrackerNavigationEntry(
  workspace: string,
  entry: TrackerNavigationEntry,
  dbOverride?: TypeDefDb,
): Promise<void> {
  if (!workspace || !isTrackerNavigationEntry(entry)) {
    throw new Error('Invalid tracker navigation entry');
  }
  const db = dbOverride ?? getDatabase();
  if (!db) throw new Error('Database not initialized');
  await db.query(
    `INSERT INTO tracker_type_navigation
       (workspace, entry_id, kind, payload, updated, deleted_at, sync_status)
     VALUES ($1, $2, $3, $4, NOW(), NULL, 'pending')
     ON CONFLICT (workspace, entry_id) DO UPDATE SET
       kind = EXCLUDED.kind,
       payload = EXCLUDED.payload,
       updated = NOW(),
       deleted_at = NULL,
       sync_status = 'pending'`,
    [workspace, entry.entryId, entry.kind, JSON.stringify(entry)],
  );
}

export async function removeTrackerNavigationEntry(
  workspace: string,
  entryId: string,
  dbOverride?: TypeDefDb,
): Promise<void> {
  const db = dbOverride ?? getDatabase();
  if (!db) throw new Error('Database not initialized');
  await db.query(
    `UPDATE tracker_type_navigation
     SET deleted_at = NOW(), updated = NOW(), sync_status = 'pending'
     WHERE workspace = $1 AND entry_id = $2 AND deleted_at IS NULL`,
    [workspace, entryId],
  );
}

export interface UnsyncedTrackerNavigationEntry {
  entryId: string;
  payload: string | null;
  deleted: boolean;
}

export async function listUnsyncedTrackerNavigationEntries(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<UnsyncedTrackerNavigationEntry[]> {
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return [];
    const result = await db.query(
      `SELECT entry_id, payload, deleted_at FROM tracker_type_navigation
       WHERE workspace = $1 AND sync_status IN ('local', 'pending')`,
      [workspace],
    ) as { rows?: Array<{ entry_id: string; payload: string | TrackerNavigationEntry; deleted_at: string | null }> } | undefined;
    return (result?.rows ?? []).map((row) => ({
      entryId: row.entry_id,
      payload: row.deleted_at ? null : (typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)),
      deleted: row.deleted_at != null,
    }));
  } catch (err) {
    logger.main.warn('[trackerNavigationStore] listUnsynced failed:', err);
    return [];
  }
}

export async function getMaxTrackerNavigationSyncId(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<number> {
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return 0;
    const result = await db.query(
      `SELECT MAX(sync_id) AS max_sync_id FROM tracker_type_navigation
       WHERE workspace = $1 AND sync_id IS NOT NULL`,
      [workspace],
    ) as { rows?: Array<{ max_sync_id: number | string | null }> } | undefined;
    const raw = result?.rows?.[0]?.max_sync_id;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(value) ? Number(value) : 0;
  } catch (err) {
    logger.main.warn('[trackerNavigationStore] getMaxSyncId failed:', err);
    return 0;
  }
}

export type ApplyRemoteNavigationResult =
  | { applied: true; deleted: boolean; entry: TrackerNavigationEntry | null }
  | { applied: false; reason: 'stale' | 'invalid' | 'error' };

export async function applyRemoteTrackerNavigationEntry(
  workspace: string,
  def: { entryId: string; payload: string | null; syncId: number },
  dbOverride?: TypeDefDb,
): Promise<ApplyRemoteNavigationResult> {
  if (!workspace || !def.entryId || !Number.isFinite(def.syncId)) {
    return { applied: false, reason: 'invalid' };
  }
  const entry = def.payload === null ? null : parsePayload(def.payload);
  if (def.payload !== null && (!entry || entry.entryId !== def.entryId)) {
    return { applied: false, reason: 'invalid' };
  }
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return { applied: false, reason: 'error' };
    const existing = await db.query(
      `SELECT sync_id FROM tracker_type_navigation WHERE workspace = $1 AND entry_id = $2`,
      [workspace, def.entryId],
    ) as { rows?: Array<{ sync_id: number | string | null }> } | undefined;
    const rawCurrent = existing?.rows?.[0]?.sync_id;
    const current = typeof rawCurrent === 'string' ? Number(rawCurrent) : rawCurrent;
    if (current != null && current >= def.syncId) return { applied: false, reason: 'stale' };

    const kind = entry?.kind ?? (def.entryId.startsWith('folder:') ? 'folder' : 'type-placement');
    const storedPayload = entry ? JSON.stringify(entry) : '{}';
    await db.query(
      `INSERT INTO tracker_type_navigation
         (workspace, entry_id, kind, payload, updated, deleted_at, sync_id, sync_status)
       VALUES ($1, $2, $3, $4, NOW(), ${def.payload === null ? 'NOW()' : 'NULL'}, $5, 'synced')
       ON CONFLICT (workspace, entry_id) DO UPDATE SET
         kind = EXCLUDED.kind,
         payload = EXCLUDED.payload,
         updated = NOW(),
         deleted_at = EXCLUDED.deleted_at,
         sync_id = EXCLUDED.sync_id,
         sync_status = 'synced'`,
      [workspace, def.entryId, kind, storedPayload, def.syncId],
    );
    return { applied: true, deleted: def.payload === null, entry };
  } catch (err) {
    logger.main.warn('[trackerNavigationStore] applyRemote failed:', err);
    return { applied: false, reason: 'error' };
  }
}
