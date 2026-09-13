/**
 * "Which sessions touched this file?" — cross-worktree, and indexable.
 *
 * The same file exists at a different absolute path in the main project and in
 * every worktree, so the lookup has to span all of them. The original query
 * spelled that as `file_path LIKE '%' || $1`, and a leading wildcard is
 * unindexable by construction: every call scanned all 130,884 `session_files`
 * rows (116 calls / 22,774 ms in a five-minute window, p99 1,457 ms), and on a
 * FIFO single-lane DB worker that queues every other IPC behind it.
 *
 * Same answer, no wildcard: resolve the candidate workspace roots through
 * `idx_session_files_workspace`, append the relative path to each, and match
 * those exact absolute paths through `idx_session_files_file`.
 */

type PGliteLike = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface SessionsForFileQuery {
  /** The workspace the caller is viewing from — a project root or a worktree. */
  workspaceId: string;
  /** The main project root for `workspaceId` (`resolveProjectPath`). */
  projectPath: string;
  /**
   * `filePath` with the `workspaceId` prefix removed, leading slash included.
   * `null` when the file is not under the workspace, which drops this to an
   * exact (workspace, path) match.
   */
  relativePath: string | null;
  /** The original absolute path, used by the exact-match fallback. */
  filePath: string;
}

/**
 * Worktrees live in a sibling directory named `<project>_worktrees/`. Matching
 * that as a range rather than a prefix LIKE is what keeps it indexed: SQLite's
 * LIKE is case-insensitive for ASCII by default, and the planner will not use
 * an index for a LIKE against a BINARY-collated column in that mode. `'0'` is
 * the codepoint immediately after `'/'`, so it is the exclusive end of the
 * range.
 */
export function worktreeRootRange(projectPath: string): { from: string; to: string } {
  return { from: `${projectPath}_worktrees/`, to: `${projectPath}_worktrees0` };
}

export async function findSessionIdsForFile(db: PGliteLike, query: SessionsForFileQuery): Promise<string[]> {
  const rows = await findFileRows(db, query, 'session_id');
  return rows.map((row) => row.session_id);
}

interface FileRow {
  session_id: string;
  timestamp?: string | Date;
  link_type?: string;
  metadata?: Record<string, unknown> | string;
}
export async function findSessionAttributionForFile(db: PGliteLike, query: SessionsForFileQuery) {
  const rows = await findFileRows(db, query, 'session_id, timestamp, link_type, metadata');
  const sessions = new Map<
    string,
    { id: string; lastFileEditAt?: number; fileAttribution?: 'inferred' | 'recorded' }
  >();
  for (const row of rows) {
    const entry = sessions.get(row.session_id) ?? { id: row.session_id };
    sessions.set(row.session_id, entry);
    if (row.link_type !== 'edited') continue;
    const timestamp = new Date(row.timestamp ?? 0).getTime();
    if (!Number.isFinite(timestamp) || timestamp < (entry.lastFileEditAt ?? 0)) continue;
    let metadata: Record<string, unknown> = {};
    try {
      metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? {};
    } catch {
      /* Old malformed metadata has no inferred marker. */
    }
    entry.lastFileEditAt = timestamp;
    entry.fileAttribution = metadata.source === 'shell-hook-inferred' ? 'inferred' : 'recorded';
  }
  return [...sessions.values()];
}

async function findFileRows(
  db: PGliteLike,
  query: SessionsForFileQuery,
  columns: string
): Promise<FileRow[]> {
  const { workspaceId, projectPath, relativePath, filePath } = query;

  if (relativePath === null) {
    const { rows } = await db.query<FileRow>(
      `SELECT DISTINCT ${columns} FROM session_files
       WHERE workspace_id = $1 AND file_path = $2`,
      [workspaceId, filePath]
    );
    return rows;
  }

  // Two indexed round trips rather than one full scan. The concatenation has to
  // happen in JS: the PG->SQLite dialect translator reads `a || b` as the jsonb
  // merge operator and rewrites it to `json_patch(a, b)` (NIM-829), so `||` is
  // not available for string building here.
  const range = worktreeRootRange(projectPath);
  const { rows: rootRows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM session_files
     WHERE workspace_id = $1
        OR workspace_id = $2
        OR (workspace_id >= $3 AND workspace_id < $4)`,
    [workspaceId, projectPath, range.from, range.to]
  );

  const candidates = new Set<string>([`${workspaceId}${relativePath}`]);
  for (const root of rootRows) candidates.add(`${root.workspace_id}${relativePath}`);

  const { rows } = await db.query<FileRow>(
    `SELECT DISTINCT ${columns} FROM session_files WHERE file_path = ANY($1)`,
    [[...candidates]]
  );
  return rows;
}
