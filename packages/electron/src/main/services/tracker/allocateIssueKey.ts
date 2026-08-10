import { formatLocalIssueKey, LOCAL_ISSUE_KEY_PREFIX } from '../../../shared/localIssueKey';

/**
 * Structural view of the database handle. Both the PGLite and better-sqlite3
 * wrappers expose `query`, and this module only needs that.
 */
interface QueryableDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Assign a newly created tracker item its issue key.
 *
 * There are two namespaces, and which one applies depends on whether a tracker
 * room owns this workspace:
 *
 * - **Room attached** -> a provisional `LC-###` key, with `issue_number` left
 *   NULL. The room is the only allocator of real issue numbers; the ack
 *   overwrites both columns. Minting a `NIM-###` here is what produced the
 *   same item showing as NIM-2521 in one workspace and NIM-2525 in another.
 * - **No room** -> today's local `MAX(issue_number)+1` in the workspace
 *   prefix. A solo workspace has no counterparty to disagree with, and
 *   renumbering every existing solo tracker would be churn for no benefit.
 *
 * Callers pass `syncActive` rather than probing here, because the create paths
 * already know it -- they use the same flag to decide whether to sync at all.
 */
export async function allocateIssueKeyForNewItem(
  db: QueryableDb,
  itemId: string,
  workspacePath: string,
  options: { syncActive: boolean; prefix: string },
): Promise<void> {
  if (options.syncActive) {
    const next = await nextLocalIssueNumber(db, workspacePath);
    await db.query(
      `UPDATE tracker_items SET issue_key = $1 WHERE id = $2`,
      [formatLocalIssueKey(next), itemId],
    );
    return;
  }

  const maxResult = await db.query<{ max_num: number | null }>(
    `SELECT MAX(issue_number) as max_num FROM tracker_items WHERE workspace = $1`,
    [workspacePath],
  );
  const nextNum = (maxResult.rows[0]?.max_num ?? 0) + 1;
  await db.query(
    `UPDATE tracker_items SET issue_number = $1, issue_key = $2 WHERE id = $3`,
    [nextNum, `${options.prefix}-${nextNum}`, itemId],
  );
}

/**
 * Highest `LC-###` suffix in this workspace, plus one.
 *
 * The suffix is read back out of `issue_key` rather than tracked in a counter
 * so there is no second piece of state to keep consistent with the rows. Local
 * keys are short-lived -- they exist only until the room acks -- so the scan
 * stays small in practice.
 */
async function nextLocalIssueNumber(db: QueryableDb, workspacePath: string): Promise<number> {
  const result = await db.query<{ key: string }>(
    `SELECT issue_key AS key FROM tracker_items
     WHERE workspace = $1 AND issue_key LIKE '${LOCAL_ISSUE_KEY_PREFIX}-%'`,
    [workspacePath],
  );
  let max = 0;
  for (const row of result.rows) {
    // Parse in JS, not SQL: PGLite and SQLite differ on CAST of a non-numeric
    // string enough that doing this in the query would throw on one of them.
    if (typeof row?.key !== 'string') continue;
    const suffix = Number(row.key.slice(LOCAL_ISSUE_KEY_PREFIX.length + 1));
    if (Number.isSafeInteger(suffix) && suffix > max) max = suffix;
  }
  return max + 1;
}
