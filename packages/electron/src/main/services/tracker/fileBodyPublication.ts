import * as fs from 'fs/promises';
import * as path from 'path';
import type { TrackerItem } from '@nimbalyst/runtime';
import {
  buildFullDocumentTrackerId,
  parseFullDocumentTrackerId,
  setShareInFrontmatter,
  setTrackerIdInFrontmatter,
  extractFrontmatter as extractTrackerFrontmatter,
  updateFrontmatter,
  EXTENSION_OWNED_KEYS,
  FrontmatterWriteError,
  LEGACY_KEY_TO_TYPE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';
import { database } from '../../database/PGLiteDatabaseWorker';
import { findLinkedDocumentForLocalPath } from '../CollabLocalOriginService';
import { applyHeadlessBodyMarkdown, readHeadlessBodyMarkdown } from '../MainBodyDocService';
import { resolveTrackerSharingPolicy, shouldSyncTrackerItem } from '../TrackerPolicyService';
import { isTrackerSyncActive, syncTrackerItem, unsyncTrackerItem } from '../TrackerSyncManager';

type TrackerRow = { id: string; [key: string]: any };

export interface FileBackedPublicationContext {
  isLegacyFullDocumentRow: boolean;
  relativePath: string;
}

interface PublicationDependencies {
  workspacePath: string;
  rowToTrackerItem: (row: TrackerRow) => TrackerItem;
  updateTrackerItemContent: (itemId: string, content: any) => Promise<void>;
}

interface MigrationDependencies extends PublicationDependencies {
  parseTrackerContentColumn: (raw: string) => any;
}

interface SetPublishedDependencies extends PublicationDependencies {
  demoteFileBackedTrackerRow: (row: TrackerRow) => Promise<{ newId: string; oldId: string }>;
  promoteFileBackedTrackerRow: (row: TrackerRow) => Promise<{ newId: string; oldId: string }>;
  reconcileFrontmatterShare: (
    item: TrackerItem,
    rowId: string,
    relativePath: string,
    nowShared: boolean,
  ) => Promise<boolean>;
}

/**
 * Stand-in id for the preflight below. The real id does not exist until the row
 * is promoted, and promotion is exactly what the preflight has to run BEFORE --
 * so the rehearsal uses a value of the same shape. Any header that accepts this
 * accepts the real id: both are plain identifier strings, and the writers'
 * refusals are properties of the header, not of the value.
 */
const PREFLIGHT_TRACKER_ID = 'tr_preflight';

/**
 * The rehearsal id, guaranteed to differ from what the file already says.
 *
 * The writer skips an op whose value already matches the file, and an op that
 * changes nothing is never validated -- correct for a real write, fatal for a
 * rehearsal. A file whose `trackerId` happened to equal the fixed stand-in
 * would rehearse a no-op and let the real stamp fail after promotion.
 */
function rehearsalTrackerId(content: string): string {
  const current = extractTrackerFrontmatter(content)?.trackerId;
  return current === PREFLIGHT_TRACKER_ID ? `${PREFLIGHT_TRACKER_ID}_alt` : PREFLIGHT_TRACKER_ID;
}

/**
 * Rehearse a frontmatter write and turn a refusal into an actionable error.
 *
 * The frontmatter writers refuse a header they cannot rewrite without losing
 * the author's YAML -- a flow mapping at the root, an anchored or aliased key,
 * a duplicated key (GitHub #1552). Sharing promotes the tracker row to a new
 * persisted id BEFORE it writes `trackerId` into the file, so a refusal
 * discovered at write time would leave the row promoted under an id the file
 * never records. Running the same writers in memory first, on the content we
 * are about to write, keeps that failure ahead of every side effect.
 *
 * The rehearsed result is discarded: nothing is persisted here.
 */
function rehearseFrontmatterWrite(relativePath: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    if (err instanceof FrontmatterWriteError) {
      throw new Error(
        `Cannot update the tracker frontmatter in ${relativePath}: ${err.message} Edit the file's YAML header so it can be updated, then try again.`,
      );
    }
    throw err;
  }
}

function sharedTrackerProvenanceBody(itemId: string): string {
  return [
    '# Moved to the team tracker',
    '',
    'This file is retained only as provenance. It is not the editing surface and does not contain the shared tracker body.',
    '',
    'Edit this item in the tracker document view. Agents should use `tracker_get` and `tracker_update` with the item ID below instead of editing this file.',
    '',
    `Tracker item ID: \`${itemId}\``,
    '',
  ].join('\n');
}

/**
 * Find the tracker row backing a frontmatter file, WITHOUT filtering on
 * `source = 'frontmatter'`.
 *
 * A file-backed plan that gets shared is PROMOTED: its row keeps `source_ref`
 * but flips to `source = 'native'` under a stable id (see
 * `promoteFileBackedTrackerRow`). Every file->row lookup therefore has to
 * match on provenance rather than on source, or the next frontmatter scan
 * misses the promoted row and inserts a duplicate `fm:` row for the same file.
 *
 * Resolution order:
 *   1. the file's declared `trackerId` (exact row id) -- survives a rename,
 *   2. `source_ref` match regardless of `source`.
 */
export async function findRowForFrontmatterFile(
  workspacePath: string,
  relativePath: string,
  trackerType: string,
  frontmatter?: Record<string, any> | null,
): Promise<TrackerRow | null> {
  const declaredId = typeof frontmatter?.trackerId === 'string' ? frontmatter.trackerId.trim() : '';
  if (declaredId) {
    const byDeclaredId = await database.query<TrackerRow>(
      `SELECT * FROM tracker_items WHERE id = $1 AND workspace = $2 LIMIT 1`,
      [declaredId, workspacePath],
    );
    if (byDeclaredId.rows.length > 0) return byDeclaredId.rows[0];
  }

  const bySourceRef = await database.query<TrackerRow>(
    `SELECT * FROM tracker_items
     WHERE workspace = $1 AND source_ref = $2 AND type = $3
     ORDER BY updated DESC
     LIMIT 1`,
    [workspacePath, relativePath, trackerType],
  );
  return bySourceRef.rows[0] || null;
}

/**
 * Whether a row is a PROMOTED file-backed item: it still records the markdown
 * file it came from, but it is now an ordinary native item whose content lives
 * in the `tracker-content/<id>` collab room.
 *
 * Its markdown file is an INERT ORIGIN -- the source at promotion time and
 * nothing after. Callers use this to skip the frontmatter projection's content
 * and field refresh, which would otherwise clobber the shared body with a
 * stale local file on the next rescan.
 *
 * `declaredId` is the file's own `trackerId`, and a match on it is decisive.
 * The sync round-trip rewrites the sharer's row from the incoming payload,
 * which carries no file path -- so a promoted row loses `source_ref` once it
 * comes back down from the room. Provenance alone is therefore not a reliable
 * signal; the file pointing AT the row is.
 */
export function isPromotedTrackerRow(
  row: { id?: string; source?: string | null; source_ref?: string | null; body_version?: number | string | null } | null,
  declaredId?: string,
): boolean {
  if (!row) return false;
  if (declaredId && row.id === declaredId) return true;
  return row.source === 'native' && typeof row.source_ref === 'string' && row.source_ref.length > 0;
}

/**
 * Turn a promoted plan/decision file into an inert provenance pointer.
 *
 * The tracker room is the only content-bearing object after publication. The
 * file keeps its extension-owned frontmatter so unpublishing can restore the
 * familiar local shape, but it carries neither the body nor a second `share`
 * flag. A direct file edit is therefore visibly an edit to a pointer, not a
 * stale copy of the plan teammates are reading.
 */
export async function writeSharedTrackerProvenanceFile(
  workspacePath: string,
  relativePath: string,
  itemId: string,
): Promise<void> {
  const fullPath = path.join(workspacePath, relativePath);
  const existing = await fs.readFile(fullPath, 'utf-8');
  const next = buildSharedTrackerProvenanceContent(existing, itemId);
  if (next !== existing) {
    await fs.writeFile(fullPath, next, 'utf-8');
  }
}

/**
 * The provenance pointer's content, as a pure function of the file's current
 * content.
 *
 * Split out from the write so the publication preflight can rehearse the WHOLE
 * pipeline -- the `share` / `trackerId` stamp and this cleanup -- against the
 * same code the cleanup runs. The cleanup deletes `share` and rewrites a nested
 * legacy block, both of which the frontmatter writers can refuse on a header
 * the initial stamp accepted; discovering that at cleanup time would leave the
 * row promoted and the body already moved (GitHub #1552).
 */
export function buildSharedTrackerProvenanceContent(existing: string, itemId: string): string {
  let withoutFileSharingState = setShareInFrontmatter(existing, null);

  // Older plan extensions sometimes nested `share` inside their owned block.
  // Strip those legacy copies too; leaving one would make the provenance file
  // look independently shared even though the promoted row ignores it.
  const frontmatter = extractTrackerFrontmatter(withoutFileSharingState);
  if (frontmatter) {
    const trackerBlocks = new Set([
      ...Object.keys(EXTENSION_OWNED_KEYS),
      ...Object.keys(LEGACY_KEY_TO_TYPE),
      'trackerStatus',
    ]);
    const sanitizedBlocks: Record<string, unknown> = {};
    for (const key of trackerBlocks) {
      const block = frontmatter[key];
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      if (
        !Object.prototype.hasOwnProperty.call(block, 'share') &&
        !Object.prototype.hasOwnProperty.call(block, 'shared')
      ) continue;
      const { share: _share, shared: _shared, ...sanitized } = block as Record<string, unknown>;
      sanitizedBlocks[key] = sanitized;
    }
    if (Object.keys(sanitizedBlocks).length > 0) {
      withoutFileSharingState = updateFrontmatter(withoutFileSharingState, sanitizedBlocks);
    }
  }

  const withTrackerId = setTrackerIdInFrontmatter(withoutFileSharingState, itemId);
  const frontmatterMatch = withTrackerId.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
  return `${frontmatterMatch?.[1] ?? ''}${sharedTrackerProvenanceBody(itemId)}`;
}

/**
 * Normalize an already-promoted plan's origin file back to its provenance
 * pointer -- but never at the cost of the last copy of the body.
 *
 * The publication path collapses the file only after
 * `applyHeadlessBodyMarkdown` reports a server acknowledgment. This path has
 * no such call to gate on: it fires from a rescan or a frontmatter save, long
 * after the fact, on rows whose only local evidence is `body_version > 0`.
 * That marker is bumped BEFORE the room write is attempted, so a publication
 * whose ack never arrived leaves exactly the shape this method used to trust:
 * promoted row, `body_version = 1`, empty room, and a file that is now the
 * only place the plan exists.
 *
 * So when the file still carries content, ask the room. A non-empty body
 * there is the server's own word that the move happened; `null` (unreachable
 * or unsynced -- offline included) and an empty room both leave the file
 * alone. A DIFFERENT non-empty body is still a collapse: the room owning a
 * body teammates have since edited is exactly the state D7 describes.
 */
export async function normalizePromotedOriginFile(
  workspacePath: string,
  relativePath: string,
  itemId: string,
): Promise<void> {
  const fullPath = path.join(workspacePath, relativePath);
  let existing: string;
  try {
    existing = await fs.readFile(fullPath, 'utf-8');
  } catch {
    return;
  }

  const bodyMatch = existing.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
  const fileBody = (bodyMatch ? bodyMatch[1] : existing).trim();
  const isAlreadyPointer =
    !fileBody || fileBody === sharedTrackerProvenanceBody(itemId).trim();

  // Nothing to lose: the remaining rewrite only strips stale file-level share
  // state, so it needs no proof and costs no room read.
  if (isAlreadyPointer) {
    await writeSharedTrackerProvenanceFile(workspacePath, relativePath, itemId);
    return;
  }

  const roomBody = await readHeadlessBodyMarkdown(workspacePath, itemId);
  if (typeof roomBody !== 'string' || !roomBody.trim()) {
    console.warn(
      `[DocumentService] ${relativePath} still holds the body of promoted item ${itemId} and the room could not be shown to hold it; leaving the file intact`,
    );
    return;
  }

  await writeSharedTrackerProvenanceFile(workspacePath, relativePath, itemId);
}

/**
 * Promote a file-backed (frontmatter) tracker row to a stable native id.
 *
 * Sharing a plan copies its markdown into the item's collab doc, but the row
 * kept `id = fm:<type>:<local path>` -- so every copy-link surface emitted a
 * link addressed by the SHARER's file path, which no teammate can open, and
 * the collab room inherited that non-URL-safe id. Promotion happens at share
 * time, BEFORE the first room push, so the `fm:` id never reaches the wire and
 * no room migration is needed.
 *
 * The row is renamed (not copied) and `source` flips to `'native'`, keeping
 * `source_ref` / `document_path` for provenance. Two behaviors fall out of the
 * flip: `getCanonicalTrackerItemIdFromRow` returns the stable id, and the
 * detail view's `isNativeItem` switches the sharer to the collaborative editor.
 *
 * Callers own the file write -- promotion is paired with a single write that
 * puts `trackerId` and `share` in the frontmatter together, so a rescan never
 * observes a half-promoted file.
 */
export async function promoteFileBackedTrackerRow(row: TrackerRow): Promise<{ newId: string; oldId: string }> {
  const oldId: string = row.id;
  const newId = `${row.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await database.query(
    `UPDATE tracker_items SET id = $1, source = 'native' WHERE id = $2`,
    [newId, oldId],
  );
  // Anything keyed by the item id has to follow the rename or it silently
  // detaches (a favorited plan loses its star, the cached body goes missing).
  await database.query(`UPDATE tracker_body_cache SET item_id = $1 WHERE item_id = $2`, [newId, oldId]);
  await database.query(`UPDATE tracker_personal_state SET item_id = $1 WHERE item_id = $2`, [newId, oldId]);
  await database.query(
    `UPDATE tracker_relationship_index SET source_item_id = $1 WHERE source_item_id = $2`,
    [newId, oldId],
  );
  await database.query(
    `UPDATE tracker_relationship_index SET target_item_id = $1 WHERE target_item_id = $2`,
    [newId, oldId],
  );

  return { newId, oldId };
}

/**
 * The workspace-relative markdown file behind a row, from whichever record of
 * it survives.
 *
 * `source_ref` / `document_path` are the normal answer, but the sync
 * round-trip rewrites a shared row from the room's payload, which carries no
 * file path -- so an item that has been shared for a while has null columns and
 * an `fm:<type>:<path>` id. For those, the id IS the record of the file.
 */
export function fileRelativePathForRow(
  row: { id: string; source_ref?: string | null; document_path?: string | null },
): string | null {
  return row.source_ref || row.document_path || parseFullDocumentTrackerId(row.id)?.relativePath || null;
}

/**
 * Write a shared item's body back into its markdown file, preserving the
 * file's frontmatter block verbatim. Best-effort: the durable copy is the row.
 *
 * The LIVE ROOM wins over the local `content` column. Teammates have been
 * editing the collab doc since the share while this row only holds whatever
 * was last cached locally -- for items shared before promotion existed that
 * column is usually null outright.
 */
async function flushTrackerBodyToFile(
  workspacePath: string,
  row: TrackerRow,
  relativePath: string,
  parseTrackerContentColumn: (raw: string) => any,
): Promise<void> {
  try {
    const roomBody = await readHeadlessBodyMarkdown(workspacePath, row.id);
    const cached = row.content != null ? parseTrackerContentColumn(row.content) : undefined;
    const body = roomBody && roomBody.trim() ? roomBody : cached;
    if (typeof body !== 'string' || !body.trim()) return;
    const fullPath = path.join(workspacePath, relativePath);
    const existing = await fs.readFile(fullPath, 'utf-8');
    const fmMatch = existing.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
    const next = fmMatch ? `${fmMatch[1]}${body}\n` : `${body}\n`;
    if (next !== existing) await fs.writeFile(fullPath, next, 'utf-8');
  } catch (err) {
    console.error('[DocumentService] flushTrackerBodyToFile failed:', err);
  }
}

/**
 * Inverse of `promoteFileBackedTrackerRow`, run when a promoted item is
 * unshared. The row returns to its `fm:<type>:<path>` id and `source =
 * 'frontmatter'`, with `source_ref` / `document_path` restored, so the file
 * becomes authoritative again and the existing file-backed unshare path (which
 * relies on the row re-projecting from disk) keeps working.
 *
 * This also covers items shared BEFORE promotion existed: their id is already
 * the `fm:` id, so the rename is a no-op and the useful work is restoring the
 * provenance columns the round-trip stripped. That is what makes
 * unshare-then-reshare a viable alternative to migrating them.
 *
 * The item's current body is flushed back to the markdown file first: the file
 * has been inert since the share, so without the flush an unshare would
 * silently revert the content to its pre-share snapshot.
 */
export async function demoteFileBackedTrackerRow(
  workspacePath: string,
  row: TrackerRow,
  parseTrackerContentColumn: (raw: string) => any,
): Promise<{ newId: string; oldId: string }> {
  const oldId: string = row.id;
  const relativePath = fileRelativePathForRow(row)!;
  const newId = buildFullDocumentTrackerId(row.type, relativePath);

  await flushTrackerBodyToFile(workspacePath, row, relativePath, parseTrackerContentColumn);

  await database.query(
    `UPDATE tracker_items
     SET id = $1, source = 'frontmatter', source_ref = $3, document_path = $3
     WHERE id = $2`,
    [newId, oldId, relativePath],
  );
  await database.query(`UPDATE tracker_body_cache SET item_id = $1 WHERE item_id = $2`, [newId, oldId]);
  await database.query(`UPDATE tracker_personal_state SET item_id = $1 WHERE item_id = $2`, [newId, oldId]);
  await database.query(
    `UPDATE tracker_relationship_index SET source_item_id = $1 WHERE source_item_id = $2`,
    [newId, oldId],
  );
  await database.query(
    `UPDATE tracker_relationship_index SET target_item_id = $1 WHERE target_item_id = $2`,
    [newId, oldId],
  );

  return { newId, oldId };
}

/**
 * Share a frontmatter-backed item's body through the standard tracker-content
 * room: read the file's markdown (sans frontmatter), persist it as the item's
 * body (bumping `body_version` + cache + metadata re-sync via
 * `updateTrackerItemContent`), then seed the live `tracker-content/<itemId>`
 * Y.Doc so a teammate who opens the item sees content immediately. Returning
 * false keeps the content-bearing file intact; publication must not finalize
 * the provenance pointer until this move succeeds.
 */
async function shareFrontmatterBody(
  dependencies: PublicationDependencies,
  itemId: string,
  relativePath: string,
  workspace: string,
): Promise<boolean> {
  try {
    const fullPath = path.join(dependencies.workspacePath, relativePath);
    let fileContent: string;
    try {
      fileContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      return false; // file vanished mid-edit -> publication cannot move its body
    }
    const bodyMatch = fileContent.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    const markdownBody = (bodyMatch ? bodyMatch[1] : fileContent).trim();
    if (!markdownBody) return true; // empty body -> nothing to move

    // Persist + bump version + cache. updateTrackerItemContent intentionally
    // skips its own headless seed to avoid the renderer autosave loop, but
    // this publication path has no live peer, so it seeds once below.
    await dependencies.updateTrackerItemContent(itemId, markdownBody);

    // Projection already stored the same markdown in `content`, so the normal
    // content updater can correctly no-op. Publication still needs a first
    // body version/cache row: it is the metadata pointer cold teammates use
    // to discover the body that just moved into the room.
    const stored = await database.query<TrackerRow>(
      `SELECT body_version FROM tracker_items WHERE id = $1`,
      [itemId],
    );
    if (Number(stored.rows[0]?.body_version ?? 0) === 0) {
      await database.query(
        `UPDATE tracker_items SET body_version = 1 WHERE id = $1`,
        [itemId],
      );
      await database.query(
        `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
         VALUES ($1, 1, $2, NOW())
         ON CONFLICT (item_id, body_version) DO NOTHING`,
        [itemId, JSON.stringify(markdownBody)],
      );
    }
    return await applyHeadlessBodyMarkdown(workspace, itemId, markdownBody);
  } catch (err) {
    console.error('[DocumentService] shareFrontmatterBody failed:', err);
    return false;
  }
}

/**
 * Push or remove a frontmatter-backed (full-document) tracker item from the
 * team TrackerRoom when its per-plan `share` flag flips (NIM-876).
 *
 * Lifecycle-share rides the normal tracker sync path. The BODY is shared the
 * same way every other tracker item's body is: through the
 * `tracker-content/<itemId>` room (MainBodyDocService / applyHeadlessBodyMarkdown),
 * NOT the file-share-to-team document index. We persist the file's markdown
 * body to the row (bumping body_version + cache) and seed the live room, so a
 * teammate opening the shared plan sees its content. When sharing is turned
 * OFF, the item is deleted from the room and reset to local.
 *
 * @param item     the projected tracker item (canonical `fm:<type>:<path>` id)
 * @param rowId    the backing DB row id (may differ from the canonical id for
 *                 legacy rows) -- used for the local sync_status write
 * @param relativePath workspace-relative path of the backing markdown file
 * @param nowShared whether the item is currently flagged for sharing
 */
export async function reconcileFrontmatterShare(
  dependencies: PublicationDependencies,
  item: TrackerItem,
  rowId: string,
  relativePath: string,
  nowShared: boolean,
): Promise<boolean> {
  const workspace = item.workspace || dependencies.workspacePath;
  try {
    if (nowShared) {
      const resolution = resolveTrackerSharingPolicy(workspace, item.type);
      if (!resolution.known) {
        // NIM-3702 step 1. The display-only read answered `personal` here for a
        // schema it had merely failed to load, so a share the user asked for
        // was silently refused and the row stayed `local`. Refusing is still
        // the conservative outcome -- nothing is published on a guess -- but it
        // must be loud, and the file keeps its share flag so a later reconcile
        // retries once the schema is there.
        console.error(
          '[DocumentService] reconcileFrontmatterShare: UNRESOLVED sharing policy for',
          item.type, 'in', workspace, `(${resolution.reason}) -- refusing to publish on a guess`,
        );
        return false;
      }
      // Respect the type policy: a `local` type never shares even if flagged.
      if (!shouldSyncTrackerItem(resolution.policy, item)) return false;
      const bodyMoved = await shareFrontmatterBody(dependencies, item.id, relativePath, workspace);
      if (!bodyMoved) return false;
      if (isTrackerSyncActive(workspace)) {
        // Re-read after the body move so the metadata push carries the body
        // version teammates use for cold loading.
        const refreshed = await database.query<TrackerRow>(
          `SELECT * FROM tracker_items WHERE id = $1`,
          [rowId],
        );
        await syncTrackerItem(
          refreshed.rows.length > 0 ? dependencies.rowToTrackerItem(refreshed.rows[0]) : item,
        );
      } else {
        // Sync not live yet. Seed the body LOCALLY anyway (NIM-880): this bumps
        // `body_version`, writes the body cache, and seeds the headless Y.Doc,
        // so when the engine reconnects the backfill ships a real bodyVersion
        // and the body is already present -- a pre-connect share that only
        // marked pending used to push metadata with bodyVersion 0 and an empty
        // body. Then mark pending so the reconnect backfill re-pushes it.
        await database.query(
          `UPDATE tracker_items SET sync_status = 'pending' WHERE id = $1`,
          [rowId],
        );
      }
      return bodyMoved;
    } else if (isTrackerSyncActive(workspace)) {
      // Unshare (live): reset the local row FIRST so the unshare always lands
      // locally even if the room delete is slow/erroring, then remove from the
      // team room best-effort. Clearing `sync_id` keeps the backfill from
      // re-processing it.
      // console.log('[DocumentService] reconcile UNSHARE(live) resetting row', rowId);
      await database.query(
        `UPDATE tracker_items SET sync_status = 'local', sync_id = NULL WHERE id = $1`,
        [rowId],
      );
      try {
        await unsyncTrackerItem(item.id, workspace);
      } catch (unsyncErr) {
        console.error('[DocumentService] reconcile unsync (room delete) failed; local row already reset:', unsyncErr);
      }
      return true;
    } else {
      // Unshare (offline): `unsyncTrackerItem` would no-op with no engine, so
      // resetting straight to 'local' (NIM-880) stranded the deletion -- the
      // row kept its `sync_id` and never re-entered the backfill candidate set,
      // so the team room kept the plan. Mark pending instead: the reconnect
      // backfill sees a previously-shared (sync_id set) but now-unflagged item
      // and issues the room tombstone.
      await database.query(
        `UPDATE tracker_items SET sync_status = 'pending' WHERE id = $1`,
        [rowId],
      );
      return true;
    }
  } catch (err) {
    console.error('[DocumentService] reconcileFrontmatterShare failed:', err);
    return false;
  }
}

export function getFileBackedPublicationContext(row: TrackerRow): FileBackedPublicationContext | null {
  // A legacy `fm:` id means the item was shared before promotion existed: the
  // round-trip stripped its provenance columns, so on `source` alone it reads
  // as a native item and the unshare guard below would refuse it. The id still
  // names the file, which makes it file-backed and therefore safe to unshare.
  const isLegacyFullDocumentRow = parseFullDocumentTrackerId(row.id) !== null;
  const relativePath = fileRelativePathForRow(row);
  const isFileBackedRow =
    !!relativePath &&
    (row.source === 'frontmatter' ||
      row.source === 'import' ||
      isPromotedTrackerRow(row) ||
      isLegacyFullDocumentRow);

  return isFileBackedRow && relativePath
    ? { isLegacyFullDocumentRow, relativePath }
    : null;
}

/**
 * File-backed plans use the markdown flag only as the transition input. Once
 * publication succeeds, the file becomes a provenance pointer with no share
 * flag; the promoted tracker row is the sole publication state.
 */
export async function setFileBackedTrackerItemPublished(
  dependencies: SetPublishedDependencies,
  initialRow: TrackerRow,
  published: boolean,
  context: FileBackedPublicationContext,
): Promise<TrackerItem> {
  let row = initialRow;
  const { isLegacyFullDocumentRow, relativePath } = context;
  const shareFlag = published
    ? { status: 'team', body: 'team' }
    : { status: 'private', body: 'private' };
  const fullPath = path.join(dependencies.workspacePath, relativePath);

  // For a file-backed plan/decision, write the top-level `share` key only as
  // an atomic transition marker beside `trackerId`. It is removed after the
  // body reaches the tracker room; the plan extension's own frontmatter block
  // stays intact so an eventual unpublish can reconstruct the local file.
  //
  // Reconcile the room push EXPLICITLY here rather than rely on the
  // file-change rescan: we also write the flag to the DB row below, so by the
  // time the rescan runs captureFrontmatterTrackerTransition sees no change
  // and skips its reconcile. reconcileFrontmatterShare pushes the item (and
  // seeds its file body) on share, or tombstones it on unshare.

  if (published) {
    // A local-origin binding means this exact markdown file already owns a
    // standalone DocumentRoom and sharing state. Publishing it as a tracker
    // item would create the two-object D7 failure before we even move the
    // body, so fail closed and leave both the row and file untouched.
    const linkedDocument = await findLinkedDocumentForLocalPath(dependencies.workspacePath, fullPath);
    if (linkedDocument) {
      throw new Error(
        `This plan is already shared as a standalone document (${linkedDocument.documentId}). Remove that shared document or clear its local-source link before publishing the plan as a tracker item.`,
      );
    }
  }

  // Prove the file's header can take the `share` / `trackerId` write before the
  // row is promoted or demoted -- see `rehearseFrontmatterWrite`. Only the
  // header shape is being tested here, so this content is NOT reused for the
  // write: demotion flushes the room body back into the file, and the write
  // below must read that fresher copy or it would revert a teammate's edits.
  const preflightContent = await fs.readFile(fullPath, 'utf-8');
  rehearseFrontmatterWrite(relativePath, () => {
    const probeId = published ? rehearsalTrackerId(preflightContent) : null;
    const withShare = setShareInFrontmatter(preflightContent, published ? shareFlag : null);
    const stamped = setTrackerIdInFrontmatter(withShare, probeId);
    // Publication does not end at the stamp: the origin file is rewritten into
    // a provenance pointer afterwards, which deletes `share` and strips nested
    // legacy sharing state. Rehearse that too -- it refuses headers the stamp
    // accepts, and by the time it runs the row is promoted and the body moved.
    if (published) buildSharedTrackerProvenanceContent(stamped, probeId!);
  });

  // PROMOTE on share / DE-PROMOTE on unshare, before anything touches the
  // room. The item's public id is the room address, so minting the stable id
  // here is what keeps the sharer's local file path off the wire and out of
  // every copy-link surface. Unshare restores the `fm:` id so the file
  // becomes authoritative again and the row re-projects from disk as before.
  if (published && !isPromotedTrackerRow(row)) {
    const { newId } = await dependencies.promoteFileBackedTrackerRow(row);
    row = (await database.query<TrackerRow>(`SELECT * FROM tracker_items WHERE id = $1`, [newId])).rows[0];
  } else if (!published && (isPromotedTrackerRow(row) || isLegacyFullDocumentRow)) {
    const { newId } = await dependencies.demoteFileBackedTrackerRow(row);
    row = (await database.query<TrackerRow>(`SELECT * FROM tracker_items WHERE id = $1`, [newId])).rows[0];
  }

  // Single file write: `trackerId` and `share` land together so a rescan can
  // never observe a half-promoted file.
  try {
    // Re-read: promotion/demotion can have rewritten the file (the demote path
    // flushes the room body back into it), and that copy is the authoritative
    // one to stamp.
    const content = await fs.readFile(fullPath, 'utf-8');
    const withShare = setShareInFrontmatter(content, published ? shareFlag : null);
    const updatedContent = setTrackerIdInFrontmatter(withShare, published ? row.id : null);
    await fs.writeFile(fullPath, updatedContent, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to write share flag to ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Mirror the flag into the DB row so the UI + reconcile see it at once.
  // Deliberately do NOT bump the row's `updated` column -- sharing is not a
  // content edit and must not advance the plan's "updated" timestamp.
  //
  // Clear/set BOTH the top-level `share` and the nested `customFields.share`:
  // the sync round-trip stores the flag nested, and isTrackerItemPublished makes
  // the nested value win -- so an unshare that only cleared the top level
  // would leave a stale nested `team` flag and the item would re-sync.
  const fmData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  if (published) {
    fmData.share = shareFlag;
    fmData.customFields = {
      ...(fmData.customFields && typeof fmData.customFields === 'object' ? fmData.customFields : {}),
      share: shareFlag,
    };
  } else {
    delete fmData.share;
    if (fmData.customFields && typeof fmData.customFields === 'object') {
      delete fmData.customFields.share;
    }
  }
  // Remove the legacy boolean entirely. Keeping `shared: false` beside the
  // canonical `share: { status: 'team' }` makes the legacy bit win when the
  // row is flattened into customFields, so the just-published item reads as
  // Draft and the body move is skipped.
  delete fmData.shared;
  await database.query(
    `UPDATE tracker_items SET data = $1 WHERE id = $2`,
    [JSON.stringify(fmData), row.id],
  );
  const fmResult = await database.query<TrackerRow>(`SELECT * FROM tracker_items WHERE id = $1`, [row.id]);
  const fmItem = dependencies.rowToTrackerItem(fmResult.rows[0]);

  const reconciled = await dependencies.reconcileFrontmatterShare(fmItem, row.id, relativePath, published);
  if (published) {
    if (!reconciled) {
      throw new Error(
        `Published tracker metadata, but could not move the body from ${relativePath} into the team tracker. The local file was left intact; retry publication before editing the shared item.`,
      );
    }
    // The tracker body is durable and has reached its one collaboration
    // room. Remove the content and the file-level share bit so the origin
    // cannot continue as either an editable plan copy or an independently
    // shared document with the same contents.
    await writeSharedTrackerProvenanceFile(dependencies.workspacePath, relativePath, row.id);
  }

  // Re-read so the emitted item reflects the final sync_status.
  const finalResult = await database.query<TrackerRow>(`SELECT * FROM tracker_items WHERE id = $1`, [row.id]);
  return dependencies.rowToTrackerItem(finalResult.rows[0]);
}

/**
 * One-shot migration for items that were ALREADY shared under an `fm:` id,
 * before promotion existed. Manual by design (`document-service:migrate-shared-
 * frontmatter-ids`): the affected set is tiny, and each row involves a live
 * room read plus a tombstone, which is not something to run on every startup.
 *
 * Per row:
 *   1. read the body from the OLD `tracker-content/fm:…` room -- NOT from the
 *      markdown file, which has been diverging since the moment of the share,
 *   2. rehearse the frontmatter stamp so a header the writers refuse skips the
 *      row before anything is promoted,
 *   3. promote the row (the `issue_number` / `issue_key` columns ride along
 *      with the rename, so NIM-2324 stays NIM-2324),
 *   4. write `trackerId` into the file's frontmatter,
 *   5. seed the new room with the carried body and push the item under the new
 *      id,
 *   6. tombstone the old id so teammates' `fm:` row disappears instead of
 *      lingering as a duplicate.
 *
 * Candidates are selected by ID SHAPE, not by `source`: the sync round-trip
 * rewrites the sharer's row from the incoming payload, which carries no file
 * path, so every already-shared item has long since become
 * `source = 'native'` with a null `source_ref` while keeping its `fm:` id. The
 * backing file is recovered from the id itself.
 *
 * `dryRun` reports the candidate set without touching anything.
 */
export async function migrateSharedFrontmatterItemsToStableIds(
  dependencies: MigrationDependencies,
  options?: { dryRun?: boolean },
): Promise<{
  dryRun: boolean;
  migrated: Array<{ oldId: string; newId: string; issueKey?: string; bodySource: string }>;
  skipped: Array<{ id: string; reason: string }>;
}> {
  const dryRun = options?.dryRun ?? false;
  const migrated: Array<{ oldId: string; newId: string; issueKey?: string; bodySource: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  const candidates = await database.query<TrackerRow>(
    `SELECT * FROM tracker_items
     WHERE workspace = $1 AND id LIKE 'fm:%' AND sync_id IS NOT NULL
     ORDER BY updated DESC`,
    [dependencies.workspacePath],
  );

  for (const row of candidates.rows) {
    const relativePath: string | null =
      row.source_ref || row.document_path || parseFullDocumentTrackerId(row.id)?.relativePath || null;
    if (!relativePath) {
      skipped.push({ id: row.id, reason: 'no backing file path' });
      continue;
    }
    if (dryRun) {
      migrated.push({ oldId: row.id, newId: '(dry run)', issueKey: row.issue_key ?? undefined, bodySource: '(dry run)' });
      continue;
    }

    try {
      const fullPath = path.join(dependencies.workspacePath, relativePath);
      const linkedDocument = await findLinkedDocumentForLocalPath(dependencies.workspacePath, fullPath);
      if (linkedDocument) {
        throw new Error(
          `source is already shared as standalone document ${linkedDocument.documentId}`,
        );
      }

      // 1. The room is the authoritative body: teammates have been editing it
      // since the share, while the file has been frozen at the pre-share text.
      const roomBody = await readHeadlessBodyMarkdown(dependencies.workspacePath, row.id);
      const cachedBody = row.content != null ? dependencies.parseTrackerContentColumn(row.content) : undefined;
      const body = (roomBody && roomBody.trim()) ? roomBody : (typeof cachedBody === 'string' ? cachedBody : '');
      const bodySource = (roomBody && roomBody.trim()) ? 'room' : (body ? 'local-cache' : 'empty');

      // 2. Prove the file can be stamped BEFORE promoting, so a header the
      // writers refuse skips the row instead of leaving it promoted under an id
      // the file never records.
      const preflightContent = await fs.readFile(fullPath, 'utf-8');
      rehearseFrontmatterWrite(relativePath, () => {
        const probeId = rehearsalTrackerId(preflightContent);
        const stamped = setTrackerIdInFrontmatter(preflightContent, probeId);
        // `normalizePromotedOriginFile` rewrites this file into a provenance
        // pointer further down, between the body move and the old room's
        // tombstone. Rehearsing it here is deliberately conservative: a header
        // it would refuse skips the row rather than stranding a promoted row
        // with an untombstoned predecessor.
        buildSharedTrackerProvenanceContent(stamped, probeId);
      });

      // 3. Promote (issue_number / issue_key follow the row).
      const { newId, oldId } = await promoteFileBackedTrackerRow(row);

      // 4. Mark the file as promoted so the next scan leaves it alone. Read the
      // file again rather than reusing step 2's copy: the rehearsal only proved
      // the header's shape, and the file is the authoritative body. The
      // frontmatter refusal was ruled out in step 2, so an IO failure is what
      // normally lands here; the migration continues and the next scan
      // re-stamps.
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        await fs.writeFile(fullPath, setTrackerIdInFrontmatter(content, newId), 'utf-8');
      } catch (err) {
        console.error(`[DocumentService] migrate: could not stamp trackerId into ${relativePath}:`, err);
      }

      // 5. Carry the body into the new room and push the item under the new id.
      let bodyMoved = true;
      if (body) {
        await dependencies.updateTrackerItemContent(newId, body);
        bodyMoved = await applyHeadlessBodyMarkdown(dependencies.workspacePath, newId, body);
      }
      if (!bodyMoved) {
        throw new Error('body did not reach the promoted tracker room');
      }
      const promotedRow = await database.query<TrackerRow>(`SELECT * FROM tracker_items WHERE id = $1`, [newId]);
      if (promotedRow.rows.length > 0 && isTrackerSyncActive(dependencies.workspacePath)) {
        await syncTrackerItem(dependencies.rowToTrackerItem(promotedRow.rows[0]));
      }

      // The room now owns the body, so the origin file remains only as a
      // provenance pointer with no independent sharing state -- but prove the
      // new room holds it before overwriting. `body` was sourced from the OLD
      // room or the local cache, and both can be empty (the sync round-trip
      // nulls `content`, and an unreachable old room reads as no body) while
      // the file on disk still carries the plan. Collapsing on `bodyMoved`
      // alone would delete that last copy for a body nothing ever moved.
      await normalizePromotedOriginFile(dependencies.workspacePath, relativePath, newId);

      // 6. Tombstone the old id. The local row is already renamed, so this
      // only removes the stale `fm:` entry from the team room.
      try {
        await unsyncTrackerItem(oldId, dependencies.workspacePath);
      } catch (err) {
        console.error(`[DocumentService] migrate: tombstoning ${oldId} failed:`, err);
      }

      migrated.push({ oldId, newId, issueKey: row.issue_key ?? undefined, bodySource });
    } catch (err) {
      skipped.push({ id: row.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { dryRun, migrated, skipped };
}
