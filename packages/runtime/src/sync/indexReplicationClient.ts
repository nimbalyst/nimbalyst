/**
 * Client side of the versioned (protocol v2) personal-index replication:
 * a revision-keyed mirror plus the page-drain state machine that fills it.
 *
 * Everything here is transport- and crypto-free. The caller supplies a
 * `request` function (one round trip on the index socket) and a `prepare`
 * function (decrypt a page's entries and apply local side effects), which is
 * what makes the ordering and coverage rules testable without a server.
 *
 * The rules this file exists to enforce:
 *
 * - **Absence is never deletion.** A page that ran out, timed out, or failed
 *   leaves the mirror incomplete, and an incomplete mirror refuses to produce a
 *   snapshot at all. Desktop reconciliation republishes anything the server
 *   appears to be missing, so handing it a partial mirror would mass-upload.
 * - **Only a terminal bootstrap or a committed contiguous delta page moves the
 *   cursor.** `recent` and `lookup` pages establish no coverage whatsoever.
 * - **Revisions, not timestamps, order rows.** A row (including a deletion
 *   tombstone) is rejected when its revision is not strictly newer than what
 *   the mirror already holds, so a slow bootstrap page cannot overwrite a live
 *   update that arrived first.
 */
import type {
  IndexEntity,
  IndexPageRequestMessage,
} from '@nimbalyst/collab-protocol';

/**
 * The response fields this state machine reads. Generic over the raw change
 * payload so a caller can pass its own encrypted wire type; the protocol's
 * `IndexPageResponseMessage` is assignable to it. Field meanings are fixed by
 * `@nimbalyst/collab-protocol/indexReplication.ts`.
 */
export interface IndexPageResponseLike<R> {
  entries: R[];
  nextPageToken?: string;
  cursor?: number;
  complete: boolean;
  resetRequired?: boolean;
}

/** An `IndexChange` whose payload has already been decrypted by the caller. */
export interface DecryptedIndexChange<S, P, F> {
  entity: IndexEntity;
  id: string;
  revision: number;
  deleted: boolean;
  removalReason?: 'expired' | 'deleted';
  session?: S;
  project?: P;
  file?: F;
}

export interface IndexReplicationMirror<S, P, F> {
  /**
   * Merge decrypted changes. Returns the subset that was actually applied;
   * anything not strictly newer than the row already held is dropped.
   */
  apply(changes: Array<DecryptedIndexChange<S, P, F>>): Array<DecryptedIndexChange<S, P, F>>;
  /**
   * The subset `apply` would accept, WITHOUT mutating anything.
   *
   * Separating the decision from the write is what makes a page retryable: the
   * local callback runs against this list first, and only a callback that
   * succeeds is allowed to move the mirror. Merging first would burn the
   * revisions -- a retry of the same page would then be rejected as "not newer"
   * and deliver nothing, while the cursor advanced past rows the local side
   * never received.
   */
  selectAccepted(changes: Array<DecryptedIndexChange<S, P, F>>): Array<DecryptedIndexChange<S, P, F>>;
  /** Highest contiguous revision whose changes are all merged, if any. */
  readonly cursor: number | undefined;
  commitCursor(cursor: number): void;
  markComplete(): void;
  /** Drop the coverage claim without discarding rows or the cursor. */
  markIncomplete(): void;
  isComplete(): boolean;
  /** Throws unless coverage is complete -- see the absence rule above. */
  snapshot(): { sessions: S[]; projects: P[]; files: F[] };
  /** Live rows regardless of coverage, for diagnostics and live-update fan-out. */
  peek(entity: IndexEntity, id: string): { revision: number; deleted: boolean } | undefined;
  /**
   * Ids the server has explicitly tombstoned. This is deletion EVIDENCE, as
   * distinct from a row simply not being present -- reconciliation republishes
   * the absent ones and must leave these alone.
   */
  deletedIds(entity: IndexEntity): string[];
  /**
   * Drop a row entirely. Used when the client re-publishes a session the mirror
   * still holds a tombstone for: the server accepted it, so it is no longer
   * deletion evidence and reconciliation must stop skipping it.
   */
  forget(entity: IndexEntity, id: string): void;
  rowCount(): number;
  /**
   * Replace every row, the cursor and coverage with another mirror's. Used to
   * swap in a freshly rebuilt baseline atomically: rows the server dropped
   * before the journal floor disappear instead of lingering from the old copy.
   */
  adopt(source: IndexReplicationMirror<S, P, F>): void;
  /** Raw rows, for `adopt`. */
  exportState(): { rows: MirrorRow<S, P, F>[]; cursor: number | undefined; complete: boolean };
  reset(): void;
}

export interface MirrorRow<S, P, F> {
  entity: IndexEntity;
  id: string;
  revision: number;
  deleted: boolean;
  removalReason?: 'expired' | 'deleted';
  value?: S | P | F;
}

export function createIndexReplicationMirror<S, P, F>(): IndexReplicationMirror<S, P, F> {
  type Row = MirrorRow<S, P, F>;
  let rows = new Map<string, Row>();
  let cursor: number | undefined;
  let complete = false;

  const key = (entity: IndexEntity, id: string) => `${entity}:${id}`;

  return {
    apply(changes) {
      const applied: Array<DecryptedIndexChange<S, P, F>> = [];
      for (const change of changes) {
        const rowKey = key(change.entity, change.id);
        const existing = rows.get(rowKey);
        // Strictly newer only. Equal revisions are re-deliveries (duplicate or
        // out-of-order pages), and a tombstone is a row like any other -- a
        // stale non-delete must never resurrect a deleted session.
        if (existing && change.revision <= existing.revision) continue;
        rows.set(rowKey, {
          entity: change.entity,
          id: change.id,
          revision: change.revision,
          deleted: change.deleted,
          removalReason: change.removalReason,
          value: change.session ?? change.project ?? change.file,
        });
        applied.push(change);
      }
      return applied;
    },
    selectAccepted(changes) {
      // `staged` mirrors what `apply` would have written as it walked the list,
      // so two revisions of one row inside a single page behave identically.
      const staged = new Map<string, number>();
      const accepted: Array<DecryptedIndexChange<S, P, F>> = [];
      for (const change of changes) {
        const rowKey = key(change.entity, change.id);
        const existingRevision = staged.get(rowKey) ?? rows.get(rowKey)?.revision;
        if (existingRevision !== undefined && change.revision <= existingRevision) continue;
        staged.set(rowKey, change.revision);
        accepted.push(change);
      }
      return accepted;
    },
    get cursor() {
      return cursor;
    },
    commitCursor(next) {
      // A cursor never rewinds: a later page cannot un-cover what an earlier
      // one already proved.
      if (cursor === undefined || next > cursor) cursor = next;
    },
    markComplete() {
      complete = true;
    },
    markIncomplete() {
      complete = false;
    },
    isComplete() {
      return complete;
    },
    snapshot() {
      if (!complete) {
        throw new Error('[IndexMirror] Refusing to snapshot an incomplete mirror');
      }
      const sessions: S[] = [];
      const projects: P[] = [];
      const files: F[] = [];
      for (const row of rows.values()) {
        if (row.deleted || row.value === undefined) continue;
        if (row.entity === 'session') sessions.push(row.value as S);
        else if (row.entity === 'project') projects.push(row.value as P);
        else files.push(row.value as F);
      }
      return { sessions, projects, files };
    },
    peek(entity, id) {
      const row = rows.get(key(entity, id));
      return row ? { revision: row.revision, deleted: row.deleted } : undefined;
    },
    deletedIds(entity) {
      const ids: string[] = [];
      for (const row of rows.values()) {
        if (row.entity === entity && row.deleted && row.removalReason !== 'expired') ids.push(row.id);
      }
      return ids;
    },
    forget(entity, id) {
      rows.delete(key(entity, id));
    },
    rowCount() {
      return rows.size;
    },
    adopt(source) {
      const state = source.exportState();
      rows = new Map(state.rows.map((row) => [key(row.entity, row.id), { ...row }]));
      cursor = state.cursor;
      complete = state.complete;
    },
    exportState() {
      return { rows: Array.from(rows.values()), cursor, complete };
    },
    reset() {
      rows = new Map();
      cursor = undefined;
      complete = false;
    },
  };
}

export type IndexPageRequestInput = Omit<
  IndexPageRequestMessage,
  'type' | 'protocolVersion' | 'requestId'
>;

export interface IndexDrainDeps<S, P, F, R> {
  mirror: IndexReplicationMirror<S, P, F>;
  /** One request/response round trip, correlated by requestId by the caller. */
  request(input: IndexPageRequestInput): Promise<IndexPageResponseLike<R>>;
  /** Decrypt a page's entries, in arrival order. Must not mutate local state. */
  prepare(entries: R[]): Promise<Array<DecryptedIndexChange<S, P, F>>>;
  /**
   * Apply this page's accepted changes to local state (cache, listeners) and
   * resolve once they are applied. Called BEFORE the page's cursor is
   * committed, so a cursor can never claim ground the local side never
   * received: if page 2 fails, page 1 is already applied AND its cursor is
   * committed, and the next delta correctly resumes after it.
   *
   * Called once per page rather than once per drain, so a long bootstrap never
   * accumulates every decrypted row in memory before anything is applied.
   */
  commitPage(applied: Array<DecryptedIndexChange<S, P, F>>): Promise<void>;
  /** Safety stop; a server that never sets `complete` must not spin forever. */
  maxPages?: number;
}

export interface DrainOutcome {
  pages: number;
  appliedCount: number;
  /** Delta only: the server dropped our cursor and a fresh bootstrap is required. */
  resetRequired: boolean;
}

const DEFAULT_MAX_PAGES = 5_000;

/**
 * Page-level shape checks, run before any callback so a malformed page costs
 * nothing locally.
 *
 * A cursor is a server-owned monotonic revision: anything that is not a
 * non-negative safe integer cannot be compared or resumed from, and committing
 * it would silently corrupt coverage.
 */
function assertPageShape(
  response: IndexPageResponseLike<unknown>,
  mode: 'bootstrap' | 'delta',
): void {
  if (response.cursor !== undefined
    && (!Number.isSafeInteger(response.cursor) || response.cursor < 0)) {
    throw new Error(`[IndexMirror] ${mode} page carried an unusable cursor: ${String(response.cursor)}`);
  }
  if (response.complete && response.nextPageToken !== undefined) {
    throw new Error(`[IndexMirror] ${mode} page claims to be terminal but also carries a next page token`);
  }
  if (!response.complete && !response.nextPageToken) {
    throw new Error(`[IndexMirror] ${mode} page is neither terminal nor pageable; mirror stays partial`);
  }
  if (mode === 'bootstrap' && response.complete && response.cursor === undefined) {
    throw new Error('[IndexMirror] Terminal bootstrap page carried no cursor; coverage unproven');
  }
  if (mode === 'delta' && response.cursor === undefined && response.entries.length > 0) {
    // Applying rows we cannot record coverage for would leave them stranded:
    // the next delta resumes from the old cursor and re-sends them forever, or
    // worse, a later page advances past them.
    throw new Error('[IndexMirror] Delta page carried entries but no cursor');
  }
}

/**
 * Build the whole-account baseline, then its replay, into a fresh mirror.
 * Coverage is marked only on the terminal page, and only when that page carries
 * the cursor -- a bootstrap that ends without one has proven nothing.
 */
export async function bootstrapIndexMirror<S, P, F, R>(
  deps: IndexDrainDeps<S, P, F, R>,
): Promise<DrainOutcome> {
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  let appliedCount = 0;
  let resets = 0;

  // Build into a scratch mirror and swap it in only when the baseline and its
  // replay have both completed. Two reasons: a failed rebuild (page error,
  // decryption failure, dropped socket) must leave the existing coverage and
  // cursor untouched rather than destroying them, and a completed rebuild must
  // REPLACE the old rows wholesale so entries the server dropped before its
  // journal floor do not survive in the client's copy.
  let scratch = createIndexReplicationMirror<S, P, F>();
  let pageToken: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const response = await deps.request({ mode: 'bootstrap', pageToken });
    pages++;

    if (response.resetRequired) {
      // Start the baseline over rather than stitching two half-baselines.
      if (++resets > 2) {
        throw new Error('[IndexMirror] Bootstrap kept resetting; giving up without claiming coverage');
      }
      scratch = createIndexReplicationMirror<S, P, F>();
      appliedCount = 0;
      pageToken = undefined;
      continue;
    }

    assertPageShape(response, 'bootstrap');

    // Local state first, mirror second -- see `selectAccepted`. Rows are
    // released page by page rather than held until the terminal page.
    const accepted = scratch.selectAccepted(await deps.prepare(response.entries));
    await deps.commitPage(accepted);
    appliedCount += scratch.apply(accepted).length;

    if (response.complete) {
      scratch.commitCursor(response.cursor!);
      scratch.markComplete();
      deps.mirror.adopt(scratch);
      return { pages, appliedCount, resetRequired: false };
    }

    pageToken = response.nextPageToken;
  }

  throw new Error(`[IndexMirror] Bootstrap exceeded ${maxPages} pages; mirror stays partial`);
}

/**
 * Replay contiguous changes since the committed cursor. Each page commits its
 * own cursor after its rows merge, so an interrupted drain resumes from the
 * last fully-applied page instead of skipping the remainder.
 */
export async function deltaSyncIndexMirror<S, P, F, R>(
  deps: IndexDrainDeps<S, P, F, R>,
): Promise<DrainOutcome> {
  if (!deps.mirror.isComplete() || deps.mirror.cursor === undefined) {
    throw new Error('[IndexMirror] Delta requires an established cursor; bootstrap first');
  }
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  let appliedCount = 0;
  let pageToken: string | undefined;
  let pages = 0;

  while (pages < maxPages) {
    const response = await deps.request({
      mode: 'delta',
      sinceRevision: deps.mirror.cursor,
      pageToken,
    });
    pages++;

    if (response.resetRequired) {
      // The server can no longer replay from our cursor. Coverage is gone until
      // a bootstrap re-establishes it; it is not evidence that rows were
      // deleted. The rows themselves stay put -- the bootstrap will replace
      // them wholesale -- but the mirror stops claiming to be complete, so
      // nothing can read a snapshot out of it in the meantime.
      deps.mirror.markIncomplete();
      return { pages, appliedCount, resetRequired: true };
    }

    assertPageShape(response, 'delta');

    // Order is load-bearing: decide -> local apply -> mirror -> cursor. A
    // callback that throws leaves the mirror untouched, so the retry of this
    // same page is still "newer" and gets redelivered. Committing the cursor
    // for rows the cache never received would strand them for good.
    const accepted = deps.mirror.selectAccepted(await deps.prepare(response.entries));
    await deps.commitPage(accepted);
    appliedCount += deps.mirror.apply(accepted).length;
    if (response.cursor !== undefined) deps.mirror.commitCursor(response.cursor);

    if (response.complete) return { pages, appliedCount, resetRequired: false };
    pageToken = response.nextPageToken;
  }

  throw new Error(`[IndexMirror] Delta exceeded ${maxPages} pages`);
}
