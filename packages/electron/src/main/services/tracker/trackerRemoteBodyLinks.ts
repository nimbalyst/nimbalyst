/**
 * Index the body links of team-shared items edited by someone else.
 *
 * A teammate's body edit reaches this client only as a `bodyVersion` bump on
 * the tracker metadata socket; the text lives in the item's collaborative room
 * and remote sync never writes `tracker_items.content` (TrackerPGLiteStore
 * `applyRemoteItem`). Without this, a teammate's `A -> B` link was missing from
 * B's Links section until someone saved A's body on this machine.
 *
 * When an applied item carries a `bodyVersion` newer than anything cached
 * locally, read the room's markdown, store it in `tracker_body_cache` at that
 * version (which the workspace rebuild then prefers for shared items), and
 * reindex the item's body links. Reads run one at a time so a reconnect that
 * replays many items does not open many rooms at once.
 */
import { getDatabase } from '../../database/initialize';
import { logger } from '../../utils/logger';
import { reindexItemBodyLinks, type RelationshipIndexDb } from './trackerRelationshipIndexStore';

export interface RemoteBodyLinkDeps {
  /** Room markdown, or null when the room is unreachable or unreadable. */
  readBody: (workspacePath: string, itemId: string) => Promise<string | null>;
  db?: RelationshipIndexDb;
}

function rowsOf(result: unknown): any[] {
  const r = result as { rows?: unknown[] } | undefined;
  return Array.isArray(r?.rows) ? (r!.rows as any[]) : [];
}

/**
 * Returns true when it fetched and indexed a body. False when the cache already
 * holds this version (our own write, or an echo), the item is gone, or the room
 * could not be read -- in which case the index is left as it was.
 */
export async function refreshRemoteBodyLinks(
  workspacePath: string,
  itemId: string,
  bodyVersion: number,
  deps: RemoteBodyLinkDeps,
): Promise<boolean> {
  const db = deps.db ?? (getDatabase() as RelationshipIndexDb | null);
  if (!db || !(bodyVersion > 0)) return false;
  const item = rowsOf(await db.query(
    `SELECT id FROM tracker_items WHERE id = $1 AND workspace = $2 AND deleted_at IS NULL`,
    [itemId, workspacePath],
  ))[0];
  if (!item) return false;
  const cached = rowsOf(await db.query(
    `SELECT MAX(body_version) AS version FROM tracker_body_cache WHERE item_id = $1`,
    [itemId],
  ))[0];
  if (Number(cached?.version ?? 0) >= bodyVersion) return false;

  const markdown = await deps.readBody(workspacePath, itemId);
  if (markdown === null) return false;
  await db.query(
    `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (item_id, body_version) DO NOTHING`,
    [itemId, bodyVersion, JSON.stringify(markdown)],
  );
  await reindexItemBodyLinks(workspacePath, itemId, markdown, null, db);
  return true;
}

interface AppliedItem {
  itemId: string;
  isTombstone: boolean;
  payload: { bodyVersion?: number } | null;
}

export interface RemoteBodyLinkIndexingDeps extends RemoteBodyLinkDeps {
  onItemApplied: (listener: (workspacePath: string, applied: AppliedItem) => void) => () => void;
  /** Coalesce a burst of edits to one read per item. */
  debounceMs?: number;
}

/** Subscribe to applied tracker items; returns the unsubscribe. */
export function startRemoteBodyLinkIndexing(deps: RemoteBodyLinkIndexingDeps): () => void {
  const debounceMs = deps.debounceMs ?? 1500;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const latest = new Map<string, number>();
  let queue: Promise<void> = Promise.resolve();

  const unsubscribe = deps.onItemApplied((workspacePath, applied) => {
    const bodyVersion = Number(applied.payload?.bodyVersion ?? 0);
    if (applied.isTombstone || !(bodyVersion > 0)) return;
    const key = `${workspacePath}\u0000${applied.itemId}`;
    latest.set(key, Math.max(latest.get(key) ?? 0, bodyVersion));
    const pending = timers.get(key);
    if (pending) clearTimeout(pending);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const version = latest.get(key) ?? bodyVersion;
      latest.delete(key);
      queue = queue
        .then(() => refreshRemoteBodyLinks(workspacePath, applied.itemId, version, deps))
        .then(() => undefined)
        .catch((err) => {
          logger.main.warn('[trackerRemoteBodyLinks] remote body reindex failed for', applied.itemId, err);
        });
    }, debounceMs));
  });

  return () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
