/**
 * Local store for team-shared tracker saved views.
 *
 * Mirrors `trackerNavigationStore`: one collapsed row per view carrying its own
 * `sync_id` cursor from the saved-view lane on the tracker room. A row exists
 * only once a view has been *shared*; local-only views stay in workspace
 * settings and never touch this table.
 *
 * The payload column is TEXT, not JSONB, so the stored bytes round-trip through
 * the sync lane unchanged on both PGLite and better-sqlite3 (see DATABASE.md on
 * the JSONB sub-extraction divergence).
 */

import { getDatabase } from '../../database/initialize';
import { logger } from '../../utils/logger';
import type { TypeDefDb } from './trackerTypeDefStore';

/** A shared view as stored: an opaque JSON blob plus its id. */
export interface SharedSavedViewRecord {
  viewId: string;
  /** JSON-serialized SavedView (name + definition). */
  payload: string;
}

interface SavedViewRow {
  view_id: string;
  payload: string;
  deleted_at?: string | null;
  sync_id?: number | string | null;
}

/** Reject payloads that aren't a JSON object, so a corrupt row can't propagate. */
function isValidPayload(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export async function listSharedSavedViews(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<SharedSavedViewRecord[]> {
  if (!workspace) return [];
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return [];
    const result = await db.query(
      `SELECT view_id, payload FROM tracker_shared_saved_views
       WHERE workspace = $1 AND deleted_at IS NULL`,
      [workspace],
    ) as { rows?: SavedViewRow[] } | undefined;
    return (result?.rows ?? [])
      .filter((row) => isValidPayload(row.payload))
      .map((row) => ({ viewId: row.view_id, payload: row.payload }));
  } catch (err) {
    logger.main.warn('[trackerSavedViewStore] list failed:', err);
    return [];
  }
}

/** Share a view (or push an edit to an already-shared one). */
export async function upsertSharedSavedView(
  workspace: string,
  view: SharedSavedViewRecord,
  dbOverride?: TypeDefDb,
): Promise<void> {
  if (!workspace || !view.viewId) throw new Error('workspace and viewId are required');
  if (!isValidPayload(view.payload)) throw new Error('Saved view payload must be a JSON object');
  const db = dbOverride ?? getDatabase();
  if (!db) throw new Error('Database not initialized');
  await db.query(
    `INSERT INTO tracker_shared_saved_views
       (workspace, view_id, payload, updated, deleted_at, sync_status)
     VALUES ($1, $2, $3, NOW(), NULL, 'pending')
     ON CONFLICT (workspace, view_id) DO UPDATE SET
       payload = EXCLUDED.payload,
       updated = NOW(),
       deleted_at = NULL,
       sync_status = 'pending'`,
    [workspace, view.viewId, view.payload],
  );
}

/** Unshare a view. Tombstoned rather than deleted so peers learn about it. */
export async function removeSharedSavedView(
  workspace: string,
  viewId: string,
  dbOverride?: TypeDefDb,
): Promise<void> {
  const db = dbOverride ?? getDatabase();
  if (!db) throw new Error('Database not initialized');
  await db.query(
    `UPDATE tracker_shared_saved_views
     SET deleted_at = NOW(), updated = NOW(), sync_status = 'pending'
     WHERE workspace = $1 AND view_id = $2 AND deleted_at IS NULL`,
    [workspace, viewId],
  );
}

export interface UnsyncedSharedSavedView {
  viewId: string;
  payload: string | null;
  deleted: boolean;
}

export async function listUnsyncedSharedSavedViews(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<UnsyncedSharedSavedView[]> {
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return [];
    const result = await db.query(
      `SELECT view_id, payload, deleted_at FROM tracker_shared_saved_views
       WHERE workspace = $1 AND sync_status IN ('local', 'pending')`,
      [workspace],
    ) as { rows?: SavedViewRow[] } | undefined;
    return (result?.rows ?? []).map((row) => ({
      viewId: row.view_id,
      payload: row.deleted_at ? null : row.payload,
      deleted: row.deleted_at != null,
    }));
  } catch (err) {
    logger.main.warn('[trackerSavedViewStore] listUnsynced failed:', err);
    return [];
  }
}

export async function getMaxSharedSavedViewSyncId(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<number> {
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return 0;
    const result = await db.query(
      `SELECT MAX(sync_id) AS max_sync_id FROM tracker_shared_saved_views
       WHERE workspace = $1 AND sync_id IS NOT NULL`,
      [workspace],
    ) as { rows?: Array<{ max_sync_id: number | string | null }> } | undefined;
    const raw = result?.rows?.[0]?.max_sync_id;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(value) ? Number(value) : 0;
  } catch (err) {
    logger.main.warn('[trackerSavedViewStore] getMaxSyncId failed:', err);
    return 0;
  }
}

export type ApplyRemoteSavedViewResult =
  | { applied: true; deleted: boolean; view: SharedSavedViewRecord | null }
  | { applied: false; reason: 'stale' | 'invalid' | 'error' };

export async function applyRemoteSharedSavedView(
  workspace: string,
  def: { viewId: string; payload: string | null; syncId: number },
  dbOverride?: TypeDefDb,
): Promise<ApplyRemoteSavedViewResult> {
  if (!workspace || !def.viewId || !Number.isFinite(def.syncId)) {
    return { applied: false, reason: 'invalid' };
  }
  if (def.payload !== null && !isValidPayload(def.payload)) {
    return { applied: false, reason: 'invalid' };
  }
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return { applied: false, reason: 'error' };
    const existing = await db.query(
      `SELECT sync_id FROM tracker_shared_saved_views WHERE workspace = $1 AND view_id = $2`,
      [workspace, def.viewId],
    ) as { rows?: Array<{ sync_id: number | string | null }> } | undefined;
    const rawCurrent = existing?.rows?.[0]?.sync_id;
    const current = typeof rawCurrent === 'string' ? Number(rawCurrent) : rawCurrent;
    // The server cursor is monotonic, so an older syncId is a replay -- ignore it
    // rather than clobbering a newer local projection.
    if (current != null && current >= def.syncId) return { applied: false, reason: 'stale' };

    const storedPayload = def.payload ?? '{}';
    await db.query(
      `INSERT INTO tracker_shared_saved_views
         (workspace, view_id, payload, updated, deleted_at, sync_id, sync_status)
       VALUES ($1, $2, $3, NOW(), ${def.payload === null ? 'NOW()' : 'NULL'}, $4, 'synced')
       ON CONFLICT (workspace, view_id) DO UPDATE SET
         payload = EXCLUDED.payload,
         updated = NOW(),
         deleted_at = EXCLUDED.deleted_at,
         sync_id = EXCLUDED.sync_id,
         sync_status = 'synced'`,
      [workspace, def.viewId, storedPayload, def.syncId],
    );
    return {
      applied: true,
      deleted: def.payload === null,
      view: def.payload === null ? null : { viewId: def.viewId, payload: def.payload },
    };
  } catch (err) {
    logger.main.warn('[trackerSavedViewStore] applyRemote failed:', err);
    return { applied: false, reason: 'error' };
  }
}
