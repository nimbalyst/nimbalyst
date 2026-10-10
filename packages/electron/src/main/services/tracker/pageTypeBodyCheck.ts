/**
 * Read-back for "Set type" on a page: after a page's markdown has been seeded
 * into a new item's body, prove the item holds it before the renderer trashes
 * the page. A team item is read from its body room (the authoritative copy);
 * a personal item from its local row.
 *
 * Unreachable is never reported as empty: `readHeadlessBodyMarkdown` returns
 * null for a room it could not sync, and that must keep the page.
 */

import { database } from '../../database/PGLiteDatabaseWorker';
import { readHeadlessBodyMarkdown } from '../MainBodyDocService';
import { normalizeBodyForComparison } from '@nimbalyst/collab-client/docs';

export type ItemBodyCheck =
  | { status: 'match' }
  | { status: 'mismatch' }
  | { status: 'unreadable'; reason: string };

export interface ItemBodyCheckInput {
  workspacePath: string;
  itemId: string;
  expected: string;
  lane: 'team' | 'personal';
}

export interface ItemBodyReaders {
  readRoomBody(workspacePath: string, itemId: string): Promise<string | null>;
  readLocalBody(workspacePath: string, itemId: string): Promise<string | null>;
}

// One comparison for every copy-then-verify path (Set type, moving a page between sections).
export { normalizeBodyForComparison };

export async function checkTrackerItemBody(
  input: ItemBodyCheckInput,
  readers: ItemBodyReaders,
): Promise<ItemBodyCheck> {
  const actual = input.lane === 'team'
    ? await readers.readRoomBody(input.workspacePath, input.itemId)
    : await readers.readLocalBody(input.workspacePath, input.itemId);
  if (actual === null) {
    return {
      status: 'unreadable',
      reason: input.lane === 'team' ? 'the team room could not be reached' : 'the item was not found',
    };
  }
  return normalizeBodyForComparison(actual) === normalizeBodyForComparison(input.expected)
    ? { status: 'match' }
    : { status: 'mismatch' };
}

/**
 * The local body of an item, from its `content` column. SQLite returns the
 * stored JSON text; PGLite returns the decoded JSONB value, which for a
 * markdown body is the markdown itself. A string that does not decode to a
 * string or `{ markdown }` is therefore the body as is.
 */
export async function readLocalTrackerBody(workspacePath: string, itemId: string): Promise<string | null> {
  const result = await database.query<{ content: unknown }>(
    'SELECT content FROM tracker_items WHERE id = $1 AND workspace = $2',
    [itemId, workspacePath],
  );
  if (result.rows.length === 0) return null;
  const raw = result.rows[0].content;
  if (raw == null) return '';
  let content: unknown = raw;
  if (typeof raw === 'string') {
    try {
      content = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (typeof content === 'string') return content;
  const markdown = (content as { markdown?: unknown } | null)?.markdown;
  if (typeof markdown === 'string') return markdown;
  return typeof raw === 'string' ? raw : '';
}

export const defaultItemBodyReaders: ItemBodyReaders = {
  readRoomBody: readHeadlessBodyMarkdown,
  readLocalBody: readLocalTrackerBody,
};
