/**
 * Materializes tracker type definitions into the database so the DB (not the
 * YAML files under <workspace>/.nimbalyst/trackers) is the local source of
 * truth for custom schemas. Offline consumers (the `nim` CLI) read the
 * `tracker_type_defs` table to resolve a custom type's role->field map.
 *
 * YAML files remain the init/import format for git-backed projects; whenever the
 * app loads or (re)defines a workspace schema, the resulting model is mirrored
 * here. The `sync_id` / `sync_status` columns mirror tracker_items so a future
 * change can carry schemas over the collab sync path to peers that never pulled
 * the YAML.
 *
 * All operations are best-effort: a failure to materialize must never break
 * schema loading or `tracker_define_type`. The table may not exist yet on a
 * database that hasn't run the v12 migration, so callers tolerate errors.
 */
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getDatabase } from '../../database/initialize';
import { logger } from '../../utils/logger';

/**
 * Opaque primary-key id. Keep it human-readable but NEVER query by it with a
 * literal in SQL: the `::` reads as a Postgres type-cast and the SQLite dialect
 * translator strips it. All lookups/conflicts key on the (workspace, type)
 * unique index instead, with values passed as bound params.
 */
function typeDefId(workspace: string, type: string): string {
  return `${workspace}::${type}`;
}

/** Upsert one type definition for a workspace. */
export async function materializeTrackerTypeDef(
  workspace: string,
  model: TrackerDataModel,
  source: 'yaml' | 'cli' | 'sync' = 'yaml',
): Promise<void> {
  try {
    const db = getDatabase();
    if (!db) return;
    await db.query(
      `INSERT INTO tracker_type_defs (id, workspace, type, model, source, updated, sync_status)
       VALUES ($1, $2, $3, $4, $5, NOW(), 'local')
       ON CONFLICT (workspace, type) DO UPDATE
         SET model = EXCLUDED.model,
             source = EXCLUDED.source,
             updated = NOW(),
             deleted_at = NULL`,
      [typeDefId(workspace, model.type), workspace, model.type, JSON.stringify(model), source],
    );
  } catch (err) {
    logger.main.warn('[trackerTypeDefStore] materialize failed for', model.type, err);
  }
}

/** Upsert many type definitions (e.g. after loading a workspace's YAML dir). */
export async function materializeTrackerTypeDefs(
  workspace: string,
  models: TrackerDataModel[],
  source: 'yaml' | 'cli' | 'sync' = 'yaml',
): Promise<void> {
  for (const model of models) {
    await materializeTrackerTypeDef(workspace, model, source);
  }
}

/** Soft-tombstone a type definition (keeps a record for future sync). */
export async function removeTrackerTypeDef(workspace: string, type: string): Promise<void> {
  try {
    const db = getDatabase();
    if (!db) return;
    await db.query(
      `UPDATE tracker_type_defs SET deleted_at = NOW(), sync_status = 'pending'
       WHERE workspace = $1 AND type = $2 AND deleted_at IS NULL`,
      [workspace, type],
    );
  } catch (err) {
    logger.main.warn('[trackerTypeDefStore] remove failed for', type, err);
  }
}
