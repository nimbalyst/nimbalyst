/**
 * Local history for Personal typed page bodies.
 *
 * A Personal typed page's body exists only in this database, and agent edits
 * land in it directly (Decisions 11, 19, 20), so its local history is how a
 * person reverts one. Every body write keeps a snapshot, whoever wrote it:
 * the editor's autosave, an agent edit, or an MCP update. Same store and
 * retention as a Personal page's history (`HistoryManager`), under
 * `personal-doc://tracker-content/<itemId>`.
 *
 * Team bodies are not snapshotted here: their history is the room's revisions.
 */
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { historyManager, type HistoryManager } from '../../HistoryManager';
import { logger } from '../../utils/logger';
import { personalTypedPageHistoryKey } from '../../../shared/personalPageUri';

function bodyMarkdown(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof (content as { markdown?: unknown }).markdown === 'string') {
    return (content as { markdown: string }).markdown;
  }
  return null;
}

/**
 * A stored `tracker_items.content` value: JSON-encoded markdown, which SQLite
 * returns still encoded and PGLite may return decoded (see DATABASE.md).
 */
function storedBodyMarkdown(stored: unknown): string | null {
  if (typeof stored !== 'string') return bodyMarkdown(stored);
  try {
    return bodyMarkdown(JSON.parse(stored));
  } catch {
    return stored;
  }
}

export interface TypedPageBodySnapshotOptions {
  /**
   * The stored body this write replaced, as read from `tracker_items.content`.
   * Given by writers that did not save it themselves (an MCP update), so the
   * text an agent replaced is in history even if no save ever snapshotted it.
   */
  replaced?: unknown;
  history?: Pick<HistoryManager, 'createSnapshot'>;
}

/** Snapshot the body just written. Never throws: the write already landed. */
export async function recordTypedPageBodySnapshot(
  itemId: string,
  type: string,
  content: unknown,
  { replaced, history = historyManager }: TypedPageBodySnapshotOptions = {},
): Promise<boolean> {
  if (globalRegistry.get(type)?.sharing !== 'personal') return false;
  const markdown = bodyMarkdown(content);
  if (!markdown) return false;
  const key = personalTypedPageHistoryKey(itemId);
  try {
    const before = replaced === undefined ? null : storedBodyMarkdown(replaced);
    // HistoryManager skips text equal to the latest snapshot, so a body the
    // editor already saved is not kept twice.
    if (before && before !== markdown) await history.createSnapshot(key, before, 'pre-apply', 'Before agent edit');
    await history.createSnapshot(key, markdown, 'auto-save', 'Auto-save');
    return true;
  } catch (error) {
    logger.main.error('[typedPageBodyHistory] Failed to snapshot a Personal typed page body:', { itemId, error });
    return false;
  }
}
