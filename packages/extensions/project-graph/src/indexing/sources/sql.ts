/**
 * Small shared helpers for the database-backed sources.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';

export type QueryFn = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * The query surface, or `null` when the extension does not hold the database
 * read permission. Callers must report that as `unavailable` rather than as an
 * empty result — "no permission" and "no records" are different answers.
 */
export function requireQuery(host: PanelHost): QueryFn | null {
  const query = host.data?.query;
  return typeof query === 'function' ? (query.bind(host.data) as QueryFn) : null;
}

/**
 * Run a scalar `COUNT(*)` and normalize the result.
 *
 * PGLite returns a bigint-ish value that arrives as a string for large counts;
 * better-sqlite3 returns a number. Both are coerced here, and an unparseable
 * result becomes `null` (unknown) rather than 0 (which would read as "empty").
 */
export async function countRows(query: QueryFn, sql: string, params: unknown[]): Promise<number | null> {
  const rows = await query<{ n: number | string | null }>(sql, params);
  const raw = rows[0]?.n;
  if (raw == null) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : null;
}
