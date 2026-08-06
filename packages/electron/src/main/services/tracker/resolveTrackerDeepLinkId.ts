/**
 * Map an incoming tracker deep-link id onto the tracker row that currently
 * holds it.
 *
 * Two kinds of link outlive the id they were minted with:
 *
 *   - `fm:<type>:<path>` links copied (or embedded in a document as
 *     `tracker://fm:…`) BEFORE a file-backed plan was promoted to a stable
 *     native id at share time. The row still records the file in `source_ref`,
 *     so the path resolves it.
 *   - issue keys (`NIM-2324`), which are stable across any id rewrite.
 *
 * Resolution is best-effort: an id we cannot place is returned unchanged so the
 * renderer's own lookup still gets its shot.
 */

import { parseFullDocumentTrackerId } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';

interface QueryableDatabase {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** `NIM-2324` — an issue key, not a row id. */
const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export async function resolveTrackerDeepLinkId(
  database: QueryableDatabase,
  workspacePath: string,
  incomingId: string,
): Promise<string> {
  const id = incomingId?.trim();
  if (!id) return incomingId;

  try {
    const direct = await database.query<{ id: string }>(
      `SELECT id FROM tracker_items WHERE id = $1 AND workspace = $2 LIMIT 1`,
      [id, workspacePath],
    );
    if (direct.rows.length > 0) return direct.rows[0].id;

    if (ISSUE_KEY_PATTERN.test(id)) {
      const byKey = await database.query<{ id: string }>(
        `SELECT id FROM tracker_items WHERE workspace = $1 AND UPPER(issue_key) = UPPER($2) LIMIT 1`,
        [workspacePath, id],
      );
      if (byKey.rows.length > 0) return byKey.rows[0].id;
      return incomingId;
    }

    const parsed = parseFullDocumentTrackerId(id);
    if (parsed) {
      const bySourceRef = await database.query<{ id: string }>(
        `SELECT id FROM tracker_items
         WHERE workspace = $1 AND source_ref = $2 AND type = $3
         ORDER BY updated DESC
         LIMIT 1`,
        [workspacePath, parsed.relativePath, parsed.trackerType],
      );
      if (bySourceRef.rows.length > 0) return bySourceRef.rows[0].id;
    }
  } catch {
    // A resolution failure must never swallow the navigation.
  }

  return incomingId;
}
