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
 * Minimal DB surface these writes need (PGLite or better-sqlite3). Injectable so
 * the materialization lifecycle can be unit-tested against a real in-memory
 * SQLite without the global app database.
 */
export interface TypeDefDb {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

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
  dbOverride?: TypeDefDb,
): Promise<void> {
  try {
    const db = dbOverride ?? getDatabase();
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
  dbOverride?: TypeDefDb,
): Promise<void> {
  for (const model of models) {
    await materializeTrackerTypeDef(workspace, model, source, dbOverride);
  }
}

/** One active (non-tombstoned) materialized type definition row. */
export interface MaterializedTypeDef {
  type: string;
  source: string | null;
}

/** Active materialized type definition row including the stored model JSON. */
export interface MaterializedTypeDefFull extends MaterializedTypeDef {
  /** The model serialized as JSON TEXT (`JSON.stringify(model)` at materialize time). */
  model: string;
}

/**
 * List the active (not soft-deleted) materialized type definitions for a
 * workspace. Used to reconcile the DB mirror against the YAML set on load.
 */
export async function listMaterializedTrackerTypes(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<MaterializedTypeDef[]> {
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return [];
    const result = (await db.query(
      `SELECT type, source FROM tracker_type_defs
       WHERE workspace = $1 AND deleted_at IS NULL`,
      [workspace],
    )) as { rows?: MaterializedTypeDef[] } | undefined;
    return result?.rows ?? [];
  } catch (err) {
    logger.main.warn('[trackerTypeDefStore] list failed for', workspace, err);
    return [];
  }
}

/**
 * Like {@link listMaterializedTrackerTypes} but also returns the stored model
 * JSON, so the caller can compare the DB mirror against the on-disk YAML and
 * detect drift (Epic B Phase 2). Active (non-tombstoned) rows only.
 */
export async function listMaterializedTrackerTypeDefs(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<MaterializedTypeDefFull[]> {
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return [];
    const result = (await db.query(
      `SELECT type, source, model FROM tracker_type_defs
       WHERE workspace = $1 AND deleted_at IS NULL`,
      [workspace],
    )) as { rows?: MaterializedTypeDefFull[] } | undefined;
    return result?.rows ?? [];
  } catch (err) {
    logger.main.warn('[trackerTypeDefStore] listFull failed for', workspace, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Drift detection (Epic B Phase 2)
//
// The DB mirror is the local source of truth for the `nim` CLI, while YAML in
// <workspace>/.nimbalyst/trackers is the init/import format for git-backed
// projects. The two can fall out of step: a YAML edit that never materialized,
// a YAML file deleted while its row lingers, or a CLI/sync-created type with no
// backing file. These helpers classify those states so the settings UI can warn
// the user and offer a one-click resync.
// ---------------------------------------------------------------------------

export type SchemaDriftStatus =
  /** YAML and DB mirror agree. */
  | 'in-sync'
  /** Both exist but the model definitions differ. */
  | 'drifted'
  /** Only YAML exists; the DB mirror has no active row yet. */
  | 'yaml-only'
  /** Only the DB mirror has it, and it was sourced from YAML (orphaned file). */
  | 'db-only-orphan'
  /** Only the DB mirror has it, sourced from CLI/sync (no YAML expected). */
  | 'db-native';

export interface SchemaDriftEntry {
  type: string;
  status: SchemaDriftStatus;
  /** DB mirror source for the type, when a DB row exists. */
  source: string | null;
}

/** Stable JSON stringify (sorted keys) so key ordering never reads as drift. */
function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const sortKeys = (val: unknown): unknown => {
    if (val === null || typeof val !== 'object') return val;
    if (seen.has(val as object)) return null;
    seen.add(val as object);
    if (Array.isArray(val)) return val.map(sortKeys);
    const obj = val as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  };
  return JSON.stringify(sortKeys(value));
}

/**
 * Compare the on-disk YAML models against the DB mirror rows and classify each
 * type. Pure: no DB or filesystem access, so it is trivially unit-testable.
 *
 * A `db-only` row sourced from YAML is an orphan (its file was deleted) and is
 * reported as drift; a `db-only` row sourced from CLI/sync is DB-native and is
 * informational, not a warning.
 */
export function classifyTrackerSchemaDrift(
  yamlModels: TrackerDataModel[],
  dbDefs: Array<{ type: string; source: string | null; model: string }>,
): SchemaDriftEntry[] {
  const yamlByType = new Map<string, TrackerDataModel>();
  for (const m of yamlModels) yamlByType.set(m.type, m);

  const dbByType = new Map<string, { source: string | null; model: string }>();
  for (const d of dbDefs) dbByType.set(d.type, { source: d.source, model: d.model });

  const entries: SchemaDriftEntry[] = [];
  const types = new Set<string>([...yamlByType.keys(), ...dbByType.keys()]);

  for (const type of [...types].sort()) {
    const yaml = yamlByType.get(type);
    const db = dbByType.get(type);

    if (yaml && db) {
      let dbCanon: string;
      try {
        dbCanon = canonicalize(JSON.parse(db.model));
      } catch {
        dbCanon = '';
      }
      const status: SchemaDriftStatus =
        canonicalize(yaml) === dbCanon ? 'in-sync' : 'drifted';
      entries.push({ type, status, source: db.source });
    } else if (yaml && !db) {
      entries.push({ type, status: 'yaml-only', source: null });
    } else if (!yaml && db) {
      const status: SchemaDriftStatus =
        db.source === 'yaml' ? 'db-only-orphan' : 'db-native';
      entries.push({ type, status, source: db.source });
    }
  }

  return entries;
}

/** True if any entry represents a mirror inconsistency worth warning about. */
export function hasSchemaDrift(entries: SchemaDriftEntry[]): boolean {
  return entries.some(
    (e) =>
      e.status === 'drifted' ||
      e.status === 'yaml-only' ||
      e.status === 'db-only-orphan',
  );
}

/**
 * Reconcile the YAML-sourced DB mirror to exactly the set of types currently
 * loaded from `<workspace>/.nimbalyst/trackers/*.yaml`. Any YAML-sourced type
 * that no longer has a backing file is soft-tombstoned so offline consumers (the
 * `nim` CLI) stop resolving a custom type the user deleted.
 *
 * Only `source = 'yaml'` rows are in scope: `cli`/`sync`-sourced definitions did
 * not come from this workspace's YAML dir, so a YAML-load must never retract
 * them (e.g. a schema synced from a peer that was never written to YAML).
 * Best-effort; never throws.
 */
export async function reconcileYamlTrackerTypeDefs(
  workspace: string,
  loadedTypes: string[],
  dbOverride?: TypeDefDb,
): Promise<void> {
  const active = await listMaterializedTrackerTypes(workspace, dbOverride);
  const keep = new Set(loadedTypes);
  for (const row of active) {
    if (row.source === 'yaml' && !keep.has(row.type)) {
      await removeTrackerTypeDef(workspace, row.type, dbOverride);
    }
  }
}

// ---------------------------------------------------------------------------
// Team schema sync (Epic B Phase 3)
//
// The DB mirror is the local source of truth for custom schemas; these helpers
// are the per-project sync seam that carries a schema definition between
// teammates over the collab channel. They are transport-agnostic: a future
// TrackerRoom handler (server-side, separate repo) pushes the outbox and applies
// inbound deltas through `applyRemoteTrackerSchemaDef`. The `source = 'sync'`
// lane is kept strictly separate from yaml/cli rows, so `reconcileYamlTracker-
// TypeDefs` (yaml-only) never retracts a schema a peer sent us.
// ---------------------------------------------------------------------------

/**
 * A tracker schema definition as it arrives from a peer over the sync path.
 * `model` is the JSON-serialized TrackerDataModel, or `null` for a deletion
 * (tombstone). `syncId` is the server-assigned monotonic version for this
 * type's schema row; higher wins (mirrors tracker_items envelope semantics).
 */
export interface RemoteTrackerSchemaDef {
  type: string;
  model: string | null;
  syncId: number;
}

export type ApplyRemoteSchemaResult =
  | { applied: true; deleted: boolean }
  | { applied: false; reason: 'stale' | 'invalid' | 'error' };

/**
 * Apply a schema definition received from a peer into the local mirror, in the
 * `source = 'sync'` lane. Version-gated by `syncId`: a stale or duplicate
 * delivery can never clobber a newer row (re-delivering the same syncId is a
 * no-op). A null `model` tombstones the type, stamped 'synced' rather than
 * 'pending' — the deletion came FROM sync, so there is nothing to push back.
 *
 * Deliberately authoritative for synced types: a local row with no syncId
 * (NULL — a yaml/cli materialization) is overwritten, because team schema sync
 * makes the shared definition the source of truth for that type. The YAML
 * reconcile path only touches `source = 'yaml'` rows, so a synced row is never
 * retracted by a local YAML load.
 *
 * Ordering assumption: deltas for a given type arrive in syncId order on the
 * ordered sync stream, so a deletion is only delivered after the versions it
 * supersedes. A delete for a type we have never seen is an idempotent no-op.
 *
 * Self-contained: never throws (returns a structured result) so a malformed
 * delta can't break the sync loop.
 */
export async function applyRemoteTrackerSchemaDef(
  workspace: string,
  def: RemoteTrackerSchemaDef,
  dbOverride?: TypeDefDb,
): Promise<ApplyRemoteSchemaResult> {
  if (!workspace || !def?.type || !Number.isFinite(def.syncId)) {
    return { applied: false, reason: 'invalid' };
  }
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return { applied: false, reason: 'error' };

    const existing = (await db.query(
      `SELECT sync_id FROM tracker_type_defs WHERE workspace = $1 AND type = $2`,
      [workspace, def.type],
    )) as { rows?: Array<{ sync_id: number | null }> } | undefined;
    const currentSyncId = existing?.rows?.[0]?.sync_id ?? null;

    // Only newer server versions win. NULL (a local yaml/cli row that was never
    // synced) is older than any assigned syncId, so the first delta overwrites it.
    if (currentSyncId != null && currentSyncId >= def.syncId) {
      return { applied: false, reason: 'stale' };
    }

    if (def.model === null) {
      await db.query(
        `UPDATE tracker_type_defs
            SET deleted_at = NOW(), source = 'sync', sync_id = $3, sync_status = 'synced'
          WHERE workspace = $1 AND type = $2`,
        [workspace, def.type, def.syncId],
      );
      return { applied: true, deleted: true };
    }

    await db.query(
      `INSERT INTO tracker_type_defs (id, workspace, type, model, source, updated, sync_id, sync_status)
       VALUES ($1, $2, $3, $4, 'sync', NOW(), $5, 'synced')
       ON CONFLICT (workspace, type) DO UPDATE
         SET model = EXCLUDED.model,
             source = 'sync',
             updated = NOW(),
             sync_id = EXCLUDED.sync_id,
             sync_status = 'synced',
             deleted_at = NULL`,
      [typeDefId(workspace, def.type), workspace, def.type, def.model, def.syncId],
    );
    return { applied: true, deleted: false };
  } catch (err) {
    logger.main.warn('[trackerTypeDefStore] applyRemoteTrackerSchemaDef failed for', def?.type, err);
    return { applied: false, reason: 'error' };
  }
}

/** One locally-originated schema change awaiting push to peers. */
export interface UnsyncedTrackerSchemaDef {
  type: string;
  /** JSON model, or null when this is a pending deletion (tombstone). */
  model: string | null;
  deleted: boolean;
}

/**
 * The push-side outbox: locally-originated schema rows whose changes have not
 * yet been pushed to peers (`sync_status` in 'local' | 'pending'). A pending
 * deletion (deleted_at set) surfaces with `model = null` so the push path can
 * emit a tombstone. `source = 'sync'` rows are stamped 'synced' and excluded —
 * they came FROM a peer and must never be echoed back.
 *
 * Sync-mode gate: a type whose model declares `sync.mode: 'local'` never leaves
 * the machine — its override (or override-deletion) is filtered out here, the
 * single push choke point. The `model` column retains the last-known JSON even
 * for a tombstoned row, so the mode is readable for deletions too. Types with no
 * explicit sync policy keep their prior behavior (not filtered) so this never
 * silently stops an existing custom type from syncing.
 */
export async function listUnsyncedTrackerSchemaDefs(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<UnsyncedTrackerSchemaDef[]> {
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return [];
    const result = (await db.query(
      `SELECT type, model, deleted_at FROM tracker_type_defs
        WHERE workspace = $1 AND sync_status IN ('local', 'pending')`,
      [workspace],
    )) as { rows?: Array<{ type: string; model: string; deleted_at: string | null }> } | undefined;
    const out: UnsyncedTrackerSchemaDef[] = [];
    for (const r of result?.rows ?? []) {
      if (schemaSyncModeIsLocal(r.model)) continue;
      out.push({
        type: r.type,
        model: r.deleted_at ? null : r.model,
        deleted: r.deleted_at != null,
      });
    }
    return out;
  } catch (err) {
    logger.main.warn('[trackerTypeDefStore] listUnsyncedTrackerSchemaDefs failed for', workspace, err);
    return [];
  }
}

/**
 * True when a stored model JSON declares `sync.mode: 'local'`. The `model` column
 * is JSON TEXT (a string on both backends), but parse defensively per DATABASE.md.
 * Only an EXPLICIT local mode is treated as local — undefined/other modes are not
 * filtered, preserving existing custom-type sync behavior.
 */
function schemaSyncModeIsLocal(rawModel: unknown): boolean {
  try {
    const parsed = typeof rawModel === 'string' ? JSON.parse(rawModel) : rawModel;
    return (parsed as { sync?: { mode?: string } } | null)?.sync?.mode === 'local';
  } catch {
    return false;
  }
}

/** Highest schema syncId applied in this workspace, used as the bootstrap cursor. */
export async function getMaxTrackerSchemaSyncId(
  workspace: string,
  dbOverride?: TypeDefDb,
): Promise<number> {
  try {
    const db = dbOverride ?? getDatabase();
    if (!db) return 0;
    const result = (await db.query(
      `SELECT MAX(sync_id) AS max_sync_id
         FROM tracker_type_defs
        WHERE workspace = $1
          AND sync_id IS NOT NULL`,
      [workspace],
    )) as { rows?: Array<{ max_sync_id: number | string | null }> } | undefined;
    const raw = result?.rows?.[0]?.max_sync_id;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    return Number.isFinite(value) ? Number(value) : 0;
  } catch (err) {
    logger.main.warn('[trackerTypeDefStore] getMaxTrackerSchemaSyncId failed for', workspace, err);
    return 0;
  }
}

/** Soft-tombstone a type definition (keeps a record for future sync). */
export async function removeTrackerTypeDef(
  workspace: string,
  type: string,
  dbOverride?: TypeDefDb,
): Promise<void> {
  try {
    const db = dbOverride ?? getDatabase();
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
