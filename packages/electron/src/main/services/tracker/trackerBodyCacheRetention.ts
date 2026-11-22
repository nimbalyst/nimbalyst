/**
 * `tracker_body_cache` keeps one full body per item, not one per save.
 *
 * Every body save bumps `body_version` and inserts the whole body at the new
 * version. Nothing ever deleted the older rows, so the table grew with every
 * save (one item had 198 versions) and outgrew `tracker_items` itself. Every
 * reader wants the newest row: the item's current `body_version`, or
 * `MAX(body_version)`. The one exception is version 1, which creation
 * publishing reads as the saved original (`publishTrackerCreation.ts`), so it
 * is kept too.
 *
 * Kept per item: version 1, the newest cached version, and the row at the
 * item's current `body_version`. A deleted version is a superseded copy of a
 * body whose current text is still in `tracker_items.content` and in the
 * newest cache row, and nothing reads it, so there is nothing to restore.
 *
 * SQL is written in the `$N` dialect both backends accept, and each parameter
 * appears once and in order.
 */
import { logger } from '../../utils/logger';

export interface TrackerBodyCacheDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** The version creation publishing reads back as the original body. */
export const CREATION_BODY_VERSION = 1;

/** Items examined per chunk of the background pass. */
export const BODY_CACHE_RETENTION_ITEMS_PER_CHUNK = 200;

/** Pause between chunks so foreground queries interleave. */
const BODY_CACHE_RETENTION_INTER_CHUNK_DELAY_MS = 250;

/**
 * Store a body at `bodyVersion` and drop the item's older versions (except
 * version 1). The delete only runs once the new row is confirmed present, so a
 * failed insert never leaves an item with no cached body.
 */
export async function writeTrackerBodyCacheVersion(
  db: TrackerBodyCacheDb,
  itemId: string,
  bodyVersion: number,
  contentJson: string,
): Promise<void> {
  // ON CONFLICT DO NOTHING covers two saves racing on the same version.
  await db.query(
    `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (item_id, body_version) DO NOTHING`,
    [itemId, bodyVersion, contentJson],
  );
  await db.query(
    `DELETE FROM tracker_body_cache
      WHERE item_id = $1
        AND body_version <> $2
        AND body_version < $3
        AND EXISTS (
          SELECT 1 FROM tracker_body_cache newer
           WHERE newer.item_id = $4 AND newer.body_version = $5
        )`,
    [itemId, CREATION_BODY_VERSION, bodyVersion, itemId, bodyVersion],
  );
}

export interface TrackerBodyCacheRetentionResult {
  itemsPruned: number;
  rowsDeleted: number;
}

/**
 * Delete superseded body versions from databases written before saves pruned
 * them. Walks the table in item-id chunks, so no statement scans the whole
 * table, and is idempotent: a second run finds nothing to delete.
 */
export async function runTrackerBodyCacheRetention(
  db: TrackerBodyCacheDb,
  options: {
    itemsPerChunk?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<TrackerBodyCacheRetentionResult> {
  const itemsPerChunk = options.itemsPerChunk ?? BODY_CACHE_RETENTION_ITEMS_PER_CHUNK;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let cursor = '';
  let itemsPruned = 0;
  let rowsDeleted = 0;

  for (;;) {
    const chunk = await db.query<{ item_id: string }>(
      `SELECT item_id FROM tracker_body_cache
        WHERE item_id > $1
        GROUP BY item_id
        ORDER BY item_id
        LIMIT $2`,
      [cursor, itemsPerChunk],
    );
    if (chunk.rows.length === 0) break;
    const upper = chunk.rows[chunk.rows.length - 1].item_id;

    // The newest row is never below MAX(body_version), so every item keeps at
    // least that row; version 1 and the item's current version are kept too.
    const deleted = await db.query<{ item_id: string }>(
      `DELETE FROM tracker_body_cache
        WHERE item_id > $1
          AND item_id <= $2
          AND body_version <> $3
          AND body_version < (
            SELECT MAX(newest.body_version) FROM tracker_body_cache newest
             WHERE newest.item_id = tracker_body_cache.item_id
          )
          AND body_version <> COALESCE((
            SELECT t.body_version FROM tracker_items t
             WHERE t.id = tracker_body_cache.item_id
          ), -1)
        RETURNING item_id`,
      [cursor, upper, CREATION_BODY_VERSION],
    );
    if (deleted.rows.length > 0) {
      const items = new Set(deleted.rows.map((row) => row.item_id)).size;
      itemsPruned += items;
      rowsDeleted += deleted.rows.length;
      logger.main.info(
        `[TrackerBodyCacheRetention] Deleted ${deleted.rows.length} superseded body version(s) across ${items} item(s)`,
      );
    }

    cursor = upper;
    if (chunk.rows.length < itemsPerChunk) break;
    await sleep(BODY_CACHE_RETENTION_INTER_CHUNK_DELAY_MS);
  }

  if (rowsDeleted > 0) {
    logger.main.info(
      `[TrackerBodyCacheRetention] Done: ${rowsDeleted} superseded body version(s) deleted across ${itemsPruned} item(s)`,
    );
  }
  return { itemsPruned, rowsDeleted };
}

/**
 * The scheduled entry point. `getDb` returns null when there is no database to
 * prune this way (PGLite installs have no background runner; their saves still
 * prune through `writeTrackerBodyCacheVersion`).
 */
export async function runScheduledTrackerBodyCacheRetention(
  getDb: () => { query?: TrackerBodyCacheDb['query'] } | null,
): Promise<void> {
  const runner = getDb();
  if (!runner?.query) return;
  const query = runner.query.bind(runner);
  await runTrackerBodyCacheRetention({ query });
}
