import type { DatabaseEngine } from '../database/PGLiteDatabaseWorker';

/**
 * Finds the overlay tracker item for one GitHub URL, whatever shape the row
 * stores it in.
 *
 * Why every shape: a native create flattens fields into the top level of
 * `data` (`data.prUrl`), while a team-synced row keeps them nested under
 * `data.customFields`. The triage commands write the URL as `{ url, label }`,
 * the panel writes a plain string. Matching only one shape let the panel
 * create a second overlay beside a teammate's synced item.
 *
 * The query is scoped by `type` (idx_tracker_type), so the OR across the four
 * paths runs over one type's rows, not the table.
 */

export interface DatabaseLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ExistingGithubOverlay {
  id: string;
  data: Record<string, unknown>;
}

function urlPathExpressions(engine: DatabaseEngine, key: string): string[] {
  return engine === 'sqlite'
    ? [
        `json_extract(data, '$.${key}')`,
        `json_extract(data, '$.${key}.url')`,
        `json_extract(data, '$.customFields.${key}')`,
        `json_extract(data, '$.customFields.${key}.url')`,
      ]
    : [
        `data->>'${key}'`,
        `data->'${key}'->>'url'`,
        `data->'customFields'->>'${key}'`,
        `data->'customFields'->'${key}'->>'url'`,
      ];
}

export async function findGithubOverlayByUrl(
  db: DatabaseLike,
  engine: DatabaseEngine,
  workspacePath: string,
  type: string,
  urlKey: string,
  canonicalUrl: string,
): Promise<ExistingGithubOverlay | null> {
  const matches = urlPathExpressions(engine, urlKey)
    .map((expr) => `LOWER(${expr}) = $3`)
    .join(' OR ');
  const { rows } = await db.query<{ id: string; data: unknown }>(
    `SELECT id, data
     FROM tracker_items
     WHERE type = $1
       AND workspace = $2
       AND deleted_at IS NULL
       AND (${matches})
     ORDER BY created ASC
     LIMIT 1`,
    [type, workspacePath, canonicalUrl.toLowerCase()],
  );
  const row = rows[0];
  if (!row) return null;
  const data = typeof row.data === 'string'
    ? JSON.parse(row.data) as Record<string, unknown>
    : (row.data ?? {}) as Record<string, unknown>;
  return { id: row.id, data };
}
