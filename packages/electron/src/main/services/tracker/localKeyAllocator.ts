/**
 * Allocation of machine-private tracker numbers (`NIM.12`).
 *
 * There are eight places that insert into `tracker_items`, so minting at the
 * insert would mean eight copies of the counter logic and one of them
 * eventually drifting. Instead this sweeps the workspace for rows that have no
 * number yet and assigns one to each, in creation order. New items and the
 * one-time backfill of pre-existing items are therefore the same code path,
 * and the counter is touched in exactly one function.
 *
 * Two rules make this safe, and both were violated by the attempts that were
 * rolled back:
 *
 * 1. The counter is persisted and only counts up. It is never derived from the
 *    rows -- `LC-###` recomputed it by counting rows that still carried a local
 *    key, so a number was released the moment its item was acked or deleted,
 *    and the next create reused it. A note saying "LC-2" silently came to mean
 *    a different item.
 * 2. The counter advances BEFORE the row is written. A crash in between spends
 *    a number without using it, which costs nothing. The reverse order would
 *    reissue it, which is the failure worth avoiding: a missing number is an
 *    annoyance, a recycled one sends you to the wrong item with no warning.
 */

import { formatLocalKey, parseLocalKey } from '../../../shared/localIssueKey';
import { resolveLocalKeyPrefix } from '../../../shared/trackerIssueKeyPrefix';

export interface LocalKeyStateStore {
  read(workspacePath: string): { prefix?: string; counter?: number };
  write(workspacePath: string, next: { prefix: string; counter: number }): void;
  takenPrefixes(workspacePath: string): string[];
  /** The project's team prefix, so an automatic pin can avoid colliding with it. */
  teamPrefix?(workspacePath: string): string | undefined;
}

export interface LocalKeyPrefixConfig {
  prefix: string;
  /**
   * Whether this project has already handed out numbers. Not a lock: changing
   * the prefix now rewrites them, which is worth telling the user before they
   * do it.
   */
  hasIssuedNumbers: boolean;
  matchesTeamPrefix: boolean;
  warning?: string;
}

const LOCAL_KEY_PREFIX_PATTERN = /^[A-Z]{2,5}$/;

function normalizePrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

/**
 * The local-prefix state shown in tracker settings.
 *
 * Merely opening settings does not pin the derived suggestion. The prefix is
 * persisted only when the user chooses it or the first local number is issued,
 * which keeps an untouched project free to route around prefixes claimed by
 * projects opened later in the same app session.
 */
export function getLocalKeyPrefixConfig(
  store: LocalKeyStateStore,
  workspacePath: string,
  teamPrefix?: string,
): LocalKeyPrefixConfig {
  const state = store.read(workspacePath);
  const prefix = state.prefix ?? resolveLocalKeyPrefix({
    projectNameOrPath: workspacePath,
    takenPrefixes: store.takenPrefixes(workspacePath),
    avoidPrefix: teamPrefix ?? store.teamPrefix?.(workspacePath),
  });
  const normalizedTeamPrefix = teamPrefix ? normalizePrefix(teamPrefix) : undefined;
  const matchesTeamPrefix = normalizedTeamPrefix === prefix;

  return {
    prefix,
    hasIssuedNumbers: (state.counter ?? 0) > 0,
    matchesTeamPrefix,
    ...(matchesTeamPrefix ? {
      warning: 'Using different local and team prefixes makes private numbers easier to recognize. The dot still keeps them mechanically distinct.',
    } : {}),
  };
}

/**
 * Reject a prefix nothing can be done with, whether or not numbers exist yet.
 *
 * Machine-local collisions are refused because two projects using the same
 * dotted reference would make lookup ambiguous. A matching team prefix is
 * intentionally only a warning: the team prefix may already be immutable when a
 * project joins a team, and the dot is the durable private-vs-shared boundary.
 */
function validateLocalKeyPrefix(store: LocalKeyStateStore, workspacePath: string, requestedPrefix: string): string {
  const prefix = normalizePrefix(requestedPrefix);
  if (!LOCAL_KEY_PREFIX_PATTERN.test(prefix)) {
    throw new Error('Local tracker prefix must be 2-5 uppercase letters.');
  }

  const taken = new Set(store.takenPrefixes(workspacePath).map(normalizePrefix));
  if (taken.has(prefix)) {
    throw new Error(`Local tracker prefix ${prefix} is already used by another project on this machine.`);
  }

  return prefix;
}

/**
 * Move a project's local numbers to different letters.
 *
 * The prefix is otherwise pinned on first use, and that rule is right for the
 * number: a reference already written down must not come to mean a different
 * item. Only the letters move here -- `NIM.42` becomes `NIC.42`, the counter is
 * untouched, and no number is ever reissued -- so the worst outcome is a stale
 * note that resolves to nothing instead of to the wrong item. That is the
 * trade the automatic pin made necessary: it could land on the team's own
 * letters, and spending the counter locked the result before anyone saw it.
 *
 * There is no transaction spanning the settings store and the database, so a
 * crash part-way leaves some rows on each prefix. Numbers stay unique across
 * both, which is the property worth protecting; re-running finishes the job.
 */
export async function reassignLocalKeyPrefix(
  db: QueryableDb,
  store: LocalKeyStateStore,
  workspacePath: string,
  requestedPrefix: string,
  teamPrefix?: string,
): Promise<LocalKeyPrefixConfig> {
  const prefix = validateLocalKeyPrefix(store, workspacePath, requestedPrefix);

  await withWorkspaceAllocationLock(workspacePath, async () => {
    const current = store.read(workspacePath);
    if (current.prefix === prefix) return;

    const numbered = await db.query<{ id: string; local_key: string | null }>(
      `SELECT id, local_key FROM tracker_items
        WHERE workspace = $1 AND local_key IS NOT NULL`,
      [workspacePath],
    );

    const moves = numbered.rows.flatMap((row) => {
      const parsed = row.local_key ? parseLocalKey(row.local_key) : null;
      // A key that does not parse was not written by this allocator. Leave it
      // alone rather than inventing a number for it.
      if (!parsed || parsed.prefix === prefix) return [];
      return [{ id: row.id, localKey: formatLocalKey(prefix, parsed.localNumber) }];
    });

    for (let start = 0; start < moves.length; start += ALLOCATION_CHUNK_SIZE) {
      await rewriteLocalKeys(db, workspacePath, moves.slice(start, start + ALLOCATION_CHUNK_SIZE));
    }

    // Last, so a prefix visible in settings means the rows behind it moved.
    store.write(workspacePath, { prefix, counter: current.counter ?? 0 });
  });

  return getLocalKeyPrefixConfig(store, workspacePath, teamPrefix);
}

/** Overwrite one chunk of local keys with the values the caller computed. */
async function rewriteLocalKeys(
  db: QueryableDb,
  workspacePath: string,
  moves: Array<{ id: string; localKey: string }>,
): Promise<void> {
  if (moves.length === 0) return;

  const params: unknown[] = [workspacePath];
  const branches: string[] = [];
  const idPlaceholders: string[] = [];
  for (const move of moves) {
    params.push(move.id, move.localKey);
    const idPlaceholder = `$${params.length - 1}`;
    branches.push(`WHEN ${idPlaceholder} THEN $${params.length}`);
    idPlaceholders.push(idPlaceholder);
  }

  await db.query(
    `UPDATE tracker_items SET local_key = CASE id ${branches.join(' ')} END
      WHERE workspace = $1 AND id IN (${idPlaceholders.join(', ')})`,
    params,
  );
}

interface QueryableDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const workspaceAllocationTails = new Map<string, Promise<void>>();

/**
 * Allocation touches both workspace settings and the tracker database, so the
 * database's write lane alone cannot make the combined operation atomic. Keep
 * one in-process queue per workspace and let unrelated projects proceed in
 * parallel.
 */
async function withWorkspaceAllocationLock<T>(
  workspacePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = workspaceAllocationTails.get(workspacePath) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => undefined, () => undefined);
  workspaceAllocationTails.set(workspacePath, tail);

  try {
    return await run;
  } finally {
    if (workspaceAllocationTails.get(workspacePath) === tail) {
      workspaceAllocationTails.delete(workspacePath);
    }
  }
}

/**
 * Pin this project's prefix if it does not have one yet.
 *
 * Pinning is one-way. If the project later joins a team and the room assigns
 * different letters, team keys move and local numbers do not: rewriting them
 * would change what an already-written reference points at.
 */
export function ensureLocalKeyPrefix(
  store: LocalKeyStateStore,
  workspacePath: string,
): string {
  const existing = store.read(workspacePath);
  if (existing.prefix) return existing.prefix;

  const prefix = resolveLocalKeyPrefix({
    projectNameOrPath: workspacePath,
    takenPrefixes: store.takenPrefixes(workspacePath),
    avoidPrefix: store.teamPrefix?.(workspacePath),
  });
  store.write(workspacePath, { prefix, counter: existing.counter ?? 0 });
  return prefix;
}

/**
 * Give every unnumbered item in this workspace a local number.
 *
 * Returns how many were assigned. Safe to run repeatedly: a second pass finds
 * nothing to do, so this can be called after a create without becoming a
 * per-item write.
 */
export async function assignMissingLocalKeys(
  db: QueryableDb,
  store: LocalKeyStateStore,
  workspacePath: string,
): Promise<number> {
  const unnumbered = await db.query<{ id: string }>(
    `SELECT id FROM tracker_items
      WHERE workspace = $1 AND local_key IS NULL AND deleted_at IS NULL
      ORDER BY created ASC, id ASC`,
    [workspacePath],
  );
  const assigned = await assignLocalKeysToRows(
    db,
    store,
    workspacePath,
    unnumbered.rows.map((r) => r.id),
  );
  return assigned.size;
}

/**
 * How many rows one allocation round trip covers.
 *
 * Small enough that a chunk's placeholder list stays far inside SQLite's bind
 * limit, and that a crash spends at most this many numbers.
 */
const ALLOCATION_CHUNK_SIZE = 250;

/**
 * The same allocation over rows the caller has already read.
 *
 * The tracker list query selects the workspace's rows anyway, so it can tell
 * which ones lack a number without a second round trip. In the steady state
 * that list is empty and this costs nothing at all -- which is the point, since
 * this runs on every list.
 *
 * Work is per chunk, not per row. Numbering a row costs a settings write, and
 * a settings write clones and re-persists the entire workspace store, so the
 * first launch on a large tracker spent one of those per row and blocked the
 * list for minutes. Reserving a chunk's numbers with a single write keeps the
 * one-time backfill proportional to the store, not to the row count.
 */
export async function assignLocalKeysToRows(
  db: QueryableDb,
  store: LocalKeyStateStore,
  workspacePath: string,
  rowIds: string[],
): Promise<Map<string, string>> {
  if (rowIds.length === 0) return new Map();

  return withWorkspaceAllocationLock(workspacePath, async () => {
    const assigned = new Map<string, string>();
    const prefix = ensureLocalKeyPrefix(store, workspacePath);

    for (let start = 0; start < rowIds.length; start += ALLOCATION_CHUNK_SIZE) {
      await assignChunk(
        db,
        store,
        workspacePath,
        prefix,
        rowIds.slice(start, start + ALLOCATION_CHUNK_SIZE),
        assigned,
      );
    }

    return assigned;
  });
}

/** One chunk: read what is already numbered, reserve, write, confirm. */
async function assignChunk(
  db: QueryableDb,
  store: LocalKeyStateStore,
  workspacePath: string,
  prefix: string,
  chunk: string[],
  assigned: Map<string, string>,
): Promise<void> {
  // `rowIds` came from a list query that may have completed before this sweep
  // acquired the lock. Re-read inside it so a stale caller reports the key the
  // database already holds instead of spending a new one its guarded UPDATE
  // will not write.
  const before = await db.query<{ id: string; local_key: string | null }>(
    `SELECT id, local_key FROM tracker_items
      WHERE workspace = $1 AND id = ANY($2::text[])`,
    [workspacePath, chunk],
  );

  const existing = new Map(before.rows.map((row) => [row.id, row.local_key]));
  // Walk `chunk`, not the query result: the caller ordered these by creation
  // date and the database is under no obligation to hand them back that way.
  const pending: string[] = [];
  for (const rowId of chunk) {
    const current = existing.get(rowId);
    if (current === undefined) continue;
    if (current) assigned.set(rowId, current);
    else pending.push(rowId);
  }
  if (pending.length === 0) return;

  const counter = store.read(workspacePath).counter ?? 0;
  // Persist the whole chunk's advance before any row is written, so a crash
  // here spends numbers rather than reissuing them.
  store.write(workspacePath, { prefix, counter: counter + pending.length });

  // One statement per chunk. `CASE id` carries each row's own key, and the
  // `local_key IS NULL` guard still applies per row, so a writer that bypassed
  // this queue keeps whatever it wrote.
  const params: unknown[] = [workspacePath];
  const branches: string[] = [];
  const idPlaceholders: string[] = [];
  pending.forEach((rowId, index) => {
    params.push(rowId, formatLocalKey(prefix, counter + index + 1));
    const idPlaceholder = `$${params.length - 1}`;
    branches.push(`WHEN ${idPlaceholder} THEN $${params.length}`);
    idPlaceholders.push(idPlaceholder);
  });
  await db.query(
    `UPDATE tracker_items SET local_key = CASE id ${branches.join(' ')} END
      WHERE workspace = $1 AND local_key IS NULL AND id IN (${idPlaceholders.join(', ')})`,
    params,
  );

  // Only return values the database confirms. This is deliberately not the
  // keys computed above: if any future writer bypasses this in-process queue,
  // the guarded UPDATE can still lose its race.
  const after = await db.query<{ id: string; local_key: string | null }>(
    `SELECT id, local_key FROM tracker_items
      WHERE workspace = $1 AND id = ANY($2::text[])`,
    [workspacePath, pending],
  );
  for (const row of after.rows) {
    if (row.local_key) assigned.set(row.id, row.local_key);
  }
}

/**
 * Resolve a dotted reference to a row, within one project only.
 *
 * A local number means something different in every project on the machine, so
 * resolving one without knowing which project is the ambiguity this whole
 * scheme exists to avoid. There is deliberately no workspace-less variant.
 */
export async function resolveRowByLocalKey(
  db: QueryableDb,
  reference: string,
  workspacePath: string,
): Promise<unknown | null> {
  if (!parseLocalKey(reference)) return null;
  const result = await db.query(
    `SELECT * FROM tracker_items
      WHERE local_key = $1 AND workspace = $2
      LIMIT 1`,
    [reference.trim().toUpperCase(), workspacePath],
  );
  return result.rows[0] ?? null;
}
