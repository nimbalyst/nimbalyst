/**
 * The reconnect drain for tracker items an offline write left behind.
 *
 * Every item write path gates on `isTrackerSyncActive()`, which requires a
 * `connected` engine. When it is false the row is marked `sync_status='pending'`
 * and `syncTrackerItem` is never called, so -- unlike a write that started while
 * connected -- there is no `tracker_transactions` row for `replayPending` to
 * re-drive. This function is the only thing that ever pushes those rows.
 *
 * It used to be guarded by a process-lifetime `Set`, which meant it ran on the
 * first `connected` and never again: a mid-session disconnect left every edit
 * stranded until the next app launch, and a teammate touching the same row in
 * the meantime made `applyRemoteItem` stamp it `synced`, dropping the edit out
 * of the candidate set with no rejection and no log line (NIM-3657). The schema,
 * saved-view and navigation lanes all push at the end of every bootstrap; this
 * lane now does too. The only thing worth suppressing is a second pass while one
 * is still running.
 *
 * The decision is a PURE FUNCTION (`planTrackerDrain`) that takes facts and
 * returns a plan; `runDrain` only executes it. That split exists because this
 * lane deletes items out of a team's tracker room, and its destructive branch
 * had never once executed under observation -- it could only be reached inside a
 * live engine holding a half-loaded schema registry, which is exactly the
 * situation destructive-data-paths.md says to extract the decision out of.
 * NIM-2968: on 2026-08-14 that branch deleted 26 shared items because an
 * unresolved policy was indistinguishable from a deliberate unshare.
 *
 * This lane also RECONCILES, not just pushes (NIM-3702). `sync_status` is a
 * decision cached at write time and nothing ever checked it against the policy
 * in force later, so a row written while its tracker was team stayed `pending`
 * forever once the tracker became personal -- re-examined on every reconnect,
 * counted as a routine skip, never drained. Repair lives here rather than in a
 * one-shot migration so it self-heals and a future policy change cannot strand
 * a new generation of rows.
 *
 * Dependencies arrive through a port so the decision is testable without the
 * engine registry, PGLite and Electron behind it.
 */

import type { TrackerItem } from '@nimbalyst/runtime';
import { decideBackfillAction, type TrackerSharingResolution } from '../TrackerPolicyService';

export interface TrackerItemBackfillPort {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  upsertItem: (item: TrackerItem) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  resolvePolicy: (workspacePath: string, type: string) => TrackerSharingResolution;
  /** Rows in this workspace already replicated to the room. Feeds the aggregate guard. */
  countSyncedRows: (workspacePath: string) => Promise<number>;
  /** Reported BEFORE anything executes, so a mid-run death still leaves a trace. */
  emitEvent: (event: TrackerDrainAbort) => void;
  /**
   * Give the schemas one more chance to load before an unresolved policy is
   * treated as final. Called only on the abort path, so the happy path pays
   * nothing for it.
   */
  reloadSchemas: (workspacePath: string) => Promise<void>;
  toItem: (row: any) => TrackerItem;
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

/** Why a skip happened. These causes shared one counter until NIM-3702. */
export type DrainSkipCause =
  /** Personal tracker, row agrees it is local. Normal operation. */
  | 'routine'
  /** Policy could not be resolved, but the row was never shared. */
  | 'unresolved-policy';

export type DrainRowAction =
  | { kind: 'upsert'; id: string }
  | { kind: 'delete'; id: string }
  /**
   * Correct a row stranded at `pending` by a policy that has since changed.
   *
   * `sync_status` is a decision cached at write time and nothing reconciled it
   * against the policy in force later, so rows written when a tracker was team
   * sat at `pending` forever after it became personal -- re-examined on every
   * reconnect, never drained, behind a log line that read as success. Only ever
   * issued for a row with no `sync_id`: there is no remote copy to orphan.
   */
  | { kind: 'reset-local'; id: string }
  | { kind: 'skip'; id: string; cause: DrainSkipCause };

export interface TrackerDrainAbort {
  reason: 'unresolved-policy-would-delete' | 'zero-upserts-with-deletes';
  workspacePath: string;
  /** Tracker types implicated, for the log line and the UI. */
  trackerTypes: string[];
  /** Rows held back by the abort. */
  heldBack: number;
}

export interface DrainCandidate {
  id: string;
  trackerType: string;
  previouslyShared: boolean;
  syncStatus: string | null;
  resolution: TrackerSharingResolution;
  source: Record<string, any> | null;
}

export interface DrainFacts {
  workspacePath: string;
  candidates: DrainCandidate[];
  syncedRowCount: number;
}

export interface DrainPlan {
  abort: TrackerDrainAbort | null;
  /** Empty when `abort` is set: an aborted run executes nothing at all. */
  actions: DrainRowAction[];
}

export interface TrackerItemBackfillResult {
  queued: number;
  deleted: number;
  /** Rows stranded by a policy change and corrected back to `local`. */
  repaired: number;
  skipped: number;
  /** Breakdown of `skipped`, so an unresolved read never hides inside it. */
  skippedByCause: Record<DrainSkipCause, number>;
  total: number;
  /** True when another pass was already running and this call did nothing. */
  skippedRun: boolean;
  /** Set when the plan refused to execute. No row was touched. */
  aborted: TrackerDrainAbort | null;
}

const EMPTY_RUN: TrackerItemBackfillResult = {
  queued: 0,
  deleted: 0,
  repaired: 0,
  skipped: 0,
  skippedByCause: { routine: 0, 'unresolved-policy': 0 },
  total: 0,
  skippedRun: false,
  aborted: null,
};

/** Workspaces with a pass currently running. Not a "has ever run" record. */
const inFlight = new Set<string>();

/**
 * A row stranded by a policy that changed under it: the app decided to publish
 * it, the tracker is now personal, and it was never actually replicated.
 *
 * Repairing means resetting to `local` -- NOT pushing. Do not infer intent from
 * `sync_status`: on this machine 16 `idea` rows sit at `pending` purely because
 * `idea` had no sharing declaration before 2026-07-16, and pushing them would
 * publish personal items into a team room.
 */
function isStrandedByPolicyChange(candidate: DrainCandidate): boolean {
  return candidate.resolution.known
    && candidate.resolution.policy.sharing === 'personal'
    && candidate.syncStatus === 'pending'
    && !candidate.previouslyShared;
}

function isFileProjection(source: Record<string, any> | null): boolean {
  if (source?.source === 'frontmatter') return true;
  return source?.source === 'inline' && !!source.module;
}

/**
 * Decide the whole run before any of it executes.
 *
 * Computing the plan up front is what makes the aggregate guard possible: no
 * per-row decision can see that the workspace as a whole is failing to resolve.
 */
export function planTrackerDrain(facts: DrainFacts): DrainPlan {
  const actions: DrainRowAction[] = [];
  const unresolvedShared: DrainCandidate[] = [];
  let upserts = 0;
  /**
   * Deletes caused by the TRACKER resolving personal — the shape a failed
   * policy read takes. Counted apart from a deliberate per-item unshare, where
   * the tracker is still team and only the item's published bit flipped: that
   * one is the user's own action and must never trip the aggregate guard.
   */
  let policyDrivenDeletes = 0;

  for (const candidate of facts.candidates) {
    // A markdown file reaches the team only by promotion at share time, which
    // renames its row to a native id before the first push. A projection the
    // room has never had is a local file, whatever its tracker publishes by
    // default; pushing it created test fixtures as team items. The same holds
    // for an inline `#type[...]` marker the file scan projected (it carries the
    // file as `module`); an agent-created item with an inline origin has no
    // document path and drains like a native item.
    if (!candidate.previouslyShared && isFileProjection(candidate.source)) {
      actions.push({ kind: 'skip', id: candidate.id, cause: 'routine' });
      continue;
    }
    const action = decideBackfillAction(
      candidate.resolution,
      candidate.source,
      candidate.previouslyShared,
    );

    if (action === 'abort') {
      unresolvedShared.push(candidate);
      continue;
    }
    if (action === 'upsert') {
      upserts++;
      actions.push({ kind: 'upsert', id: candidate.id });
      continue;
    }
    if (action === 'delete') {
      if (candidate.resolution.known && candidate.resolution.policy.sharing === 'personal') {
        policyDrivenDeletes++;
      }
      actions.push({ kind: 'delete', id: candidate.id });
      continue;
    }
    if (isStrandedByPolicyChange(candidate)) {
      actions.push({ kind: 'reset-local', id: candidate.id });
      continue;
    }
    actions.push({
      kind: 'skip',
      id: candidate.id,
      cause: candidate.resolution.known ? 'routine' : 'unresolved-policy',
    });
  }

  if (unresolvedShared.length > 0) {
    return {
      abort: {
        reason: 'unresolved-policy-would-delete',
        workspacePath: facts.workspacePath,
        trackerTypes: [...new Set(unresolvedShared.map((c) => c.trackerType))].sort(),
        heldBack: facts.candidates.length,
      },
      actions: [],
    };
  }

  // The aggregate signature of NIM-2968: `queued: 0  deleted: 26` in a
  // workspace holding ~2,700 synced rows. Every candidate's TRACKER resolving
  // personal in a workspace that demonstrably shares things is a failed read,
  // not 26 coincidental tracker-level unshares.
  //
  // Two exemptions, both of which would otherwise be false positives:
  //  - a workspace with nothing synced yet has no established sharing behavior
  //    to contradict;
  //  - a deliberate per-item unshare is not counted at all (see
  //    `policyDrivenDeletes`), so unsharing your only two pending items
  //    offline still propagates on reconnect instead of tripping the guard.
  if (upserts === 0 && policyDrivenDeletes > 0 && facts.syncedRowCount > 0) {
    return {
      abort: {
        reason: 'zero-upserts-with-deletes',
        workspacePath: facts.workspacePath,
        trackerTypes: [...new Set(facts.candidates.map((c) => c.trackerType))].sort(),
        heldBack: facts.candidates.length,
      },
      actions: [],
    };
  }

  return { abort: null, actions };
}

export async function drainPendingTrackerItems(
  workspacePath: string,
  port: TrackerItemBackfillPort,
): Promise<TrackerItemBackfillResult> {
  if (inFlight.has(workspacePath)) return { ...EMPTY_RUN, skippedRun: true };
  inFlight.add(workspacePath);
  try {
    return await runDrain(workspacePath, port);
  } finally {
    inFlight.delete(workspacePath);
  }
}

async function runDrain(
  workspacePath: string,
  port: TrackerItemBackfillPort,
): Promise<TrackerItemBackfillResult> {
  // Candidates: never-synced items (`sync_id IS NULL`) plus items left
  // `sync_status='pending'` by an offline mutation -- including the `nim` CLI
  // writing directly to SQLite while the app was closed. Re-pushing an
  // already-synced item is idempotent: `applyRemoteItem` flips it back to
  // 'synced' on ack, so it falls out of this set on the next pass.
  const candidates = await port.query(
    `SELECT * FROM tracker_items
     WHERE workspace = $1
       AND (sync_id IS NULL OR sync_status = 'pending')
       AND deleted_at IS NULL
     ORDER BY created ASC`,
    [workspacePath],
  );

  const rows = candidates.rows ?? [];
  if (rows.length === 0) return { ...EMPTY_RUN };

  const byId = new Map<string, any>(rows.map((row: any) => [row.id as string, row]));
  const facts = await collectFacts(workspacePath, rows, port);
  let plan = planTrackerDrain(facts);

  // Retry before destroying, per destructive-data-paths.md. An unresolved read
  // is usually a race with schema load rather than a real absence, so reload
  // the schemas and re-resolve once. Re-resolving without the reload would be
  // theatre: `resolvePolicy` is synchronous and nothing would have changed.
  if (plan.abort?.reason === 'unresolved-policy-would-delete') {
    try {
      await port.reloadSchemas(workspacePath);
    } catch (err) {
      port.log.warn('[TrackerItemBackfill] schema reload before abort failed', err);
    }
    plan = planTrackerDrain(await collectFacts(workspacePath, rows, port));
  }

  if (plan.abort) {
    // Emit BEFORE returning. #1347's recovery event was only computed if the
    // same process finished, so nine months of data loss reported nothing.
    port.emitEvent(plan.abort);
    port.log.warn(
      '[TrackerItemBackfill] ABORTED drain for', workspacePath,
      'reason:', plan.abort.reason,
      'types:', plan.abort.trackerTypes.join(','),
      'rows-held-back:', plan.abort.heldBack,
      '-- refusing to modify the team room on an unresolved sharing policy',
    );
    return { ...EMPTY_RUN, total: rows.length, aborted: plan.abort };
  }

  let queued = 0;
  let deleted = 0;
  let repaired = 0;
  const skippedByCause: Record<DrainSkipCause, number> = {
    routine: 0, 'unresolved-policy': 0,
  };

  for (const action of plan.actions) {
    if (action.kind === 'skip') {
      skippedByCause[action.cause]++;
      continue;
    }

    if (action.kind === 'reset-local') {
      try {
        // No `deleteItem`: the row has no `sync_id`, so the room never had it.
        // Guard on that in SQL too, so a row that gained one between planning
        // and execution is left alone rather than silently unlinked.
        await port.query(
          `UPDATE tracker_items SET sync_status = 'local' WHERE id = $1 AND sync_id IS NULL`,
          [action.id],
        );
        repaired++;
      } catch (err) {
        port.log.warn('[TrackerItemBackfill] reset-local failed for item', action.id, err);
      }
      continue;
    }

    const row = byId.get(action.id);
    if (!row) continue;

    if (action.kind === 'delete') {
      try {
        await port.deleteItem(action.id);
        // Reset the local row so it isn't re-processed (or re-deleted) on the
        // next reconnect.
        await port.query(
          `UPDATE tracker_items SET sync_status = 'local', sync_id = NULL WHERE id = $1`,
          [action.id],
        );
        deleted++;
      } catch (err) {
        port.log.warn('[TrackerItemBackfill] deleteItem failed for item', action.id, err);
      }
      continue;
    }

    try {
      await port.upsertItem(port.toItem(row));
      queued++;
    } catch (err) {
      // The row keeps `sync_status='pending'`, so the next connect retries it.
      port.log.warn('[TrackerItemBackfill] upsertItem failed for item', action.id, err);
    }
  }

  const skipped = skippedByCause.routine + skippedByCause['unresolved-policy'];

  port.log.info(
    '[TrackerItemBackfill] drain complete for', workspacePath,
    'queued:', queued, 'deleted:', deleted, 'repaired:', repaired,
    'skipped-local-only:', skippedByCause.routine,
    'total-candidates:', rows.length,
  );

  // Separate lines, because neither is normal operation and the single
  // `skipped-local-only` counter is what hid both of them for ten months.
  if (repaired > 0) {
    port.log.warn(
      '[TrackerItemBackfill] REPAIRED STRANDED ROWS for', workspacePath,
      'rows:', repaired,
      '-- rows sat at sync_status=pending while their tracker resolves personal;',
      'reset to local (they were never replicated)',
    );
  }
  if (skippedByCause['unresolved-policy'] > 0) {
    port.log.warn(
      '[TrackerItemBackfill] UNRESOLVED POLICY for', workspacePath,
      'rows:', skippedByCause['unresolved-policy'],
      '-- schema could not be resolved; rows were left alone',
    );
  }

  return {
    queued, deleted, repaired, skipped, skippedByCause,
    total: rows.length, skippedRun: false, aborted: null,
  };
}

async function collectFacts(
  workspacePath: string,
  rows: any[],
  port: TrackerItemBackfillPort,
): Promise<DrainFacts> {
  return {
    workspacePath,
    syncedRowCount: await port.countSyncedRows(workspacePath),
    candidates: rows.map((row) => ({
      id: row.id as string,
      trackerType: row.type as string,
      previouslyShared: row.sync_id != null,
      syncStatus: (row.sync_status as string) ?? null,
      resolution: port.resolvePolicy(workspacePath, row.type as string),
      source: port.toItem(row) as unknown as Record<string, any>,
    })),
  };
}
