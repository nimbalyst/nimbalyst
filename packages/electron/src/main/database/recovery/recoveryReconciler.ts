/**
 * Deciding what to do about a recovery that did not finish.
 *
 * Split into a pure planner and a thin applier for the reason
 * `.claude/rules/destructive-data-paths.md` gives: a destructive decision that
 * can only be triggered by an environment you cannot reproduce is in the wrong
 * place. A process killed between two renames is exactly that environment, so
 * `planRecoveryReconcile` takes the journal and a bag of observed facts and
 * returns a plan, and every crash point is an ordinary unit test.
 *
 * Two rules the planner encodes:
 *
 *   - **Paths come from the journal, never from a naming convention.** The
 *     displaced database is put back where the journal says it came from.
 *   - **Directory presence is an input, not the decision.** It tells us how far
 *     the last process got. It never tells us what to do -- that is what the
 *     phase is for. #1347 is what deciding from directory presence looks like.
 *
 * Nothing here deletes anything. The worst outcome the planner can produce is
 * "hold, and refuse to open a database", which surfaces the failure dialog
 * with every copy still on disk and named.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_RECOVERY_RECONCILE_ATTEMPTS,
  clearRecoveryJournal,
  getRecoveryJournalPath,
  readRecoveryJournalStatus,
  realRecoveryFs,
  writeRecoveryJournal,
  type RecoveryFsPort,
  type RecoveryJournal,
} from './recoveryJournal';

export interface RecoveryObservedFacts {
  /** Something exists at the journaled live path. */
  livePresent: boolean;
  /** The journaled displaced copy exists. */
  displacedPresent: boolean;
  /** The journaled staging copy exists. */
  stagingPresent: boolean;
}

export type RecoveryReconcileAction =
  /** No journal, or a journal describing an operation that never moved anything. */
  | 'nothing_to_do'
  /** The journal is stale; drop it and boot normally. */
  | 'clear_journal'
  /** Move the displaced database back to the live path, then drop the journal. */
  | 'restore_displaced'
  /** Something is at the live path that we did not put there. Leave everything. */
  | 'hold_live_occupied'
  /**
   * A recovery was running and the journal cannot be read. Nothing is moved --
   * every path this module acts on comes from the journal and this one names
   * none -- but startup is stopped from creating a database on top of a copy a
   * recovery may already have parked aside.
   */
  | 'hold_unreadable_journal'
  /** There is no live database and no copy we can safely put back. */
  | 'block_database_open';

export type RecoveryReconcileReason =
  | 'no_journal'
  | 'journal_unreadable'
  | 'nothing_moved_yet'
  | 'displace_landed_unrecorded'
  | 'live_restored_from_displaced'
  | 'promote_landed'
  | 'already_finished'
  | 'live_path_occupied'
  | 'no_copy_to_restore'
  | 'attempts_exhausted';

export interface RecoveryReconcilePlan {
  action: RecoveryReconcileAction;
  reason: RecoveryReconcileReason;
  /** Set for `restore_displaced`; always a path the journal recorded. */
  moveFrom: string | null;
  moveTo: string | null;
  /**
   * True when startup must not open or create a database. Opening PGLite or
   * SQLite at a path this plan says is empty is how a recoverable interruption
   * becomes a permanent empty install.
   */
  blockDatabaseOpen: boolean;
  /** For the log and, when blocking, for the failure dialog. */
  message: string;
}

const NOTHING: RecoveryReconcilePlan = {
  action: 'nothing_to_do',
  reason: 'no_journal',
  moveFrom: null,
  moveTo: null,
  blockDatabaseOpen: false,
  message: 'No interrupted recovery.',
};

export function planRecoveryReconcile(
  journal: RecoveryJournal | null,
  facts: RecoveryObservedFacts,
): RecoveryReconcilePlan {
  if (!journal) return NOTHING;

  const { livePath, displacedPath } = journal.paths;

  const restore = (reason: RecoveryReconcileReason): RecoveryReconcilePlan => ({
    action: 'restore_displaced',
    reason,
    moveFrom: displacedPath,
    moveTo: livePath,
    blockDatabaseOpen: false,
    message:
      'An interrupted recovery left this install without a database. Putting the previous '
      + `database back from ${path.basename(displacedPath)}. No data has been lost; every copy `
      + 'is still on disk.',
  });

  const clear = (reason: RecoveryReconcileReason, message: string): RecoveryReconcilePlan => ({
    action: 'clear_journal',
    reason,
    moveFrom: null,
    moveTo: null,
    blockDatabaseOpen: false,
    message,
  });

  const block = (reason: RecoveryReconcileReason): RecoveryReconcilePlan => ({
    action: 'block_database_open',
    reason,
    moveFrom: null,
    moveTo: null,
    blockDatabaseOpen: true,
    message:
      'A recovery was interrupted and this install has no database at its usual location. '
      + 'Nimbalyst will not create an empty one on top of it. Every copy of your database is '
      + 'still on disk; Settings > Database, or the restore option on this dialog, can put one '
      + 'back.',
  });

  // A recovery that cannot be finished or undone must stop trying. Holding is
  // only safe if the app has a database to open; without one, blocking is the
  // whole point.
  if (journal.reconcileAttempts >= MAX_RECOVERY_RECONCILE_ATTEMPTS) {
    if (facts.livePresent) {
      return clear(
        'attempts_exhausted',
        'An interrupted recovery could not be reconciled after several launches, but a database '
          + 'is present at the usual location. Leaving every recovery copy on disk.',
      );
    }
    return { ...block('attempts_exhausted'), reason: 'attempts_exhausted' };
  }

  switch (journal.phase) {
    // Nothing had been renamed when the phase was last written -- but the
    // displace rename may have been in flight, and it is not recorded until it
    // returns. So the facts decide between "genuinely nothing moved" and "the
    // move landed and we died before writing it down".
    case 'prepared':
    case 'snapshot_taken':
    case 'staged_verified': {
      if (facts.livePresent) {
        return clear('nothing_moved_yet', 'An interrupted recovery never moved the live database.');
      }
      if (!journal.liveExisted) {
        return clear(
          'nothing_moved_yet',
          'An interrupted recovery had no live database to displace.',
        );
      }
      if (facts.displacedPresent) return restore('displace_landed_unrecorded');
      return block('no_copy_to_restore');
    }

    // The window. The app announced it has no database and named both places
    // the data could be.
    case 'live_displaced': {
      if (facts.livePresent) {
        // The promote landed and we died before recording it: staging is gone
        // because it *became* the live database.
        if (!facts.stagingPresent) {
          return clear('promote_landed', 'An interrupted recovery had already completed its swap.');
        }
        // Both a live database and an untouched staging copy. We did not do
        // this, so we do not undo it either -- unpicking it would mean
        // choosing between two databases on the user's behalf.
        return {
          action: 'hold_live_occupied',
          reason: 'live_path_occupied',
          moveFrom: null,
          moveTo: null,
          blockDatabaseOpen: false,
          message:
            'An interrupted recovery found an unexpected database at the usual location. '
            + 'Leaving it alone; the displaced database and the staged copy are both still on '
            + 'disk and listed in Settings > Database.',
        };
      }
      if (facts.displacedPresent) return restore('live_restored_from_displaced');
      // The staged copy may be here, but it has not been verified since the
      // interruption and promoting it would be acting on an unchecked database.
      return block('no_copy_to_restore');
    }

    case 'promoted': {
      if (facts.livePresent) {
        return clear('promote_landed', 'An interrupted recovery had already completed its swap.');
      }
      if (facts.displacedPresent) return restore('live_restored_from_displaced');
      return block('no_copy_to_restore');
    }

    case 'reopened_verified':
      return clear('already_finished', 'A completed recovery left its journal behind.');
  }
}

// ---------------------------------------------------------------------------
// Applier
// ---------------------------------------------------------------------------

export interface RecoveryReconcileResult {
  plan: RecoveryReconcilePlan;
  /** True when the plan's filesystem work was carried out. */
  applied: boolean;
  /** Set when a planned move failed; the plan then blocks startup. */
  error: string | null;
}

export interface ReconcileRecoveryOptions {
  userDataPath: string;
  fsPort?: RecoveryFsPort;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

export function observeRecoveryFacts(
  journal: RecoveryJournal,
  fsPort: RecoveryFsPort,
): RecoveryObservedFacts {
  return {
    livePresent: fsPort.exists(journal.paths.livePath),
    displacedPresent: fsPort.exists(journal.paths.displacedPath),
    stagingPresent: fsPort.exists(journal.paths.stagingPath),
  };
}

/**
 * Recovery copies a killed transaction can leave behind, by name prefix.
 *
 * `.displaced-` is the one that matters and the only one this module will ever
 * put back: it is, by construction, the database the install was running on
 * before the recovery started. `.recovery-staging-` is the *replacement*, which
 * has not been verified since the interruption, and `.pre-restore-` is a
 * snapshot of the displaced copy. Neither is a thing to promote without a
 * journal saying so -- the readable-journal planner refuses to promote staging
 * for exactly the same reason.
 */
const DISPLACED_PREFIX = '.displaced-';
const OTHER_RECOVERY_COPY_PREFIXES = ['.recovery-staging-', '.pre-restore-'];

function isNonEmpty(target: string): boolean {
  try {
    const stat = fs.statSync(target);
    return stat.isDirectory() ? fs.readdirSync(target).length > 0 : stat.size > 0;
  } catch {
    return false;
  }
}

function recoveryCopiesIn(dir: string, base: string): { displaced: string[]; others: number } {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { displaced: [], others: 0 };
  }
  const displaced: string[] = [];
  let others = 0;
  for (const entry of entries) {
    if (!entry.startsWith(base)) continue;
    const rest = entry.slice(base.length);
    const full = path.join(dir, entry);
    // Empty leftovers are not copies of anything and must not be able to wedge
    // a boot or be mistaken for the user's database.
    if (!isNonEmpty(full)) continue;
    if (rest.startsWith(DISPLACED_PREFIX)) displaced.push(full);
    else if (OTHER_RECOVERY_COPY_PREFIXES.some((prefix) => rest.startsWith(prefix))) others++;
  }
  return { displaced, others };
}

export interface StrandedRecoveryCopies {
  /** Nothing at the live path and at least one recovery copy beside it. */
  stranded: boolean;
  /**
   * The single displaced copy to put back, or `null` when there is not exactly
   * one. Two of them is a choice between two databases and is not ours to make.
   */
  restorable: string | null;
  /** Where it would go. */
  livePath: string;
}

/**
 * What is on disk for one backend when the journal cannot be read.
 *
 * Deliberately narrow. It answers two questions and no others: would opening
 * this engine create an empty database while a copy of it sits alongside, and
 * is there exactly one displaced copy to put back.
 *
 * The names are the ones `RecoveryBackendAdapter.recoveryPathFor` mints:
 * `pglite-db.displaced-*` and `sqlite-db/nimbalyst.displaced-*.sqlite`. A
 * healthy install matches none of them and boots normally.
 */
export function observeStrandedRecoveryCopies(
  userDataPath: string,
  fsPort: RecoveryFsPort = realRecoveryFs,
): { pglite: StrandedRecoveryCopies; sqlite: StrandedRecoveryCopies } {
  const look = (dir: string, base: string, livePath: string): StrandedRecoveryCopies => {
    if (fsPort.exists(livePath)) return { stranded: false, restorable: null, livePath };
    const { displaced, others } = recoveryCopiesIn(dir, base);
    return {
      stranded: displaced.length > 0 || others > 0,
      restorable: displaced.length === 1 ? displaced[0] : null,
      livePath,
    };
  };

  const sqliteDir = path.join(userDataPath, 'sqlite-db');
  return {
    pglite: look(userDataPath, 'pglite-db', path.join(userDataPath, 'pglite-db')),
    sqlite: look(sqliteDir, 'nimbalyst', path.join(sqliteDir, 'nimbalyst.sqlite')),
  };
}

/**
 * Run at startup, before anything opens a database. Idempotent: reaching the
 * same state twice produces the same plan, and a plan that has already been
 * applied reads as `clear_journal` on the next launch.
 */
export function reconcileRecoveryOnStartup(
  opts: ReconcileRecoveryOptions,
): RecoveryReconcileResult {
  const { userDataPath } = opts;
  const fsPort = opts.fsPort ?? realRecoveryFs;
  const log = opts.log ?? (() => {});

  const read = readRecoveryJournalStatus(userDataPath);
  if (read.status === 'absent') return { plan: NOTHING, applied: false, error: null };

  if (read.status === 'unreadable') {
    return reconcileUnreadableJournal(userDataPath, fsPort, read.detail, log);
  }

  const journal = read.journal;
  const facts = observeRecoveryFacts(journal, fsPort);
  const plan = planRecoveryReconcile(journal, facts);
  log('info', '[Recovery] Reconciling an interrupted recovery', {
    phase: journal.phase,
    attempts: journal.reconcileAttempts,
    action: plan.action,
    reason: plan.reason,
    facts,
  });

  // Count the attempt before acting, for the same reason the transaction emits
  // before it acts: a launch that dies inside the reconcile must not be able to
  // retry the same rename forever.
  writeRecoveryJournal(userDataPath, {
    ...journal,
    reconcileAttempts: journal.reconcileAttempts + 1,
  });

  switch (plan.action) {
    case 'nothing_to_do':
      return { plan, applied: false, error: null };

    case 'clear_journal':
    case 'hold_live_occupied':
    case 'hold_unreadable_journal':
      log(plan.action === 'clear_journal' ? 'info' : 'warn', `[Recovery] ${plan.message}`);
      if (plan.action === 'clear_journal') clearRecoveryJournal(userDataPath);
      return { plan, applied: true, error: null };

    case 'restore_displaced': {
      try {
        const isFileBacked = journal.backend === 'sqlite';
        if (isFileBacked) fsPort.renameWithSidecars(plan.moveFrom!, plan.moveTo!);
        else fsPort.rename(plan.moveFrom!, plan.moveTo!);
        log('info', `[Recovery] ${plan.message}`);
        clearRecoveryJournal(userDataPath);
        return { plan, applied: true, error: null };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log('error', '[Recovery] Could not put the displaced database back', err);
        // The rename failed, so there is still no database at the live path.
        // Blocking is the only answer that does not create an empty one.
        return {
          plan: {
            ...plan,
            action: 'block_database_open',
            reason: 'no_copy_to_restore',
            blockDatabaseOpen: true,
            message:
              'An interrupted recovery could not put the previous database back '
              + `(${error}). Nimbalyst will not create an empty one on top of it. Every copy is `
              + 'still on disk.',
          },
          applied: false,
          error,
        };
      }
    }

    case 'block_database_open':
      log('error', `[Recovery] ${plan.message}`);
      return { plan, applied: false, error: null };
  }
}

// ---------------------------------------------------------------------------

/**
 * A recovery ran and its record is damaged.
 *
 * The cutover reconciler's answer to the same situation is "hold and refuse to
 * infer a backend", and that is right as far as it goes: every path this module
 * normally acts on comes from the journal, and this one names none. But holding
 * is not free here. A recovery killed in the `live_displaced` window leaves no
 * database at the live path, so holding means the app cannot start, and the
 * failure dialog is the user's only remaining route to a database that is
 * sitting one directory away.
 *
 * So there is one case this will act on, and its safety comes from the shape of
 * the action rather than from confidence about the journal:
 *
 *   - the live slot is EMPTY, so nothing is overwritten, replaced or deleted --
 *     the move lands in a hole;
 *   - there is EXACTLY ONE `*.displaced-*` copy, so there is no choice being
 *     made between two databases on the user's behalf;
 *   - `.displaced-` means, by construction, "what this install was running on
 *     before the recovery started", which is the same copy
 *     `planRecoveryReconcile` puts back when it CAN read the journal.
 *
 * Anything else holds: two displaced copies, none at all, or only an unverified
 * `.recovery-staging-` copy, which must never be promoted without a journal
 * saying it was verified.
 *
 * The damaged journal is renamed aside rather than deleted. It is unreadable to
 * us and it is still the only artifact saying a recovery ran at all.
 */
function reconcileUnreadableJournal(
  userDataPath: string,
  fsPort: RecoveryFsPort,
  detail: string,
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void,
): RecoveryReconcileResult {
  const observed = observeStrandedRecoveryCopies(userDataPath, fsPort);
  const acting = [observed.pglite, observed.sqlite].filter((o) => o.stranded);
  const restorable = acting.length === 1 && acting[0].restorable ? acting[0] : null;

  log('error', '[Recovery] Recovery journal present but unreadable', {
    detail,
    strandedPglite: observed.pglite.stranded,
    strandedSqlite: observed.sqlite.stranded,
    restoring: restorable?.restorable ?? null,
  });

  if (restorable) {
    const from = restorable.restorable!;
    const message =
      'A recovery was interrupted and its record did not survive. There is no database at the '
      + `usual location and exactly one displaced copy beside it, so ${path.basename(from)} is `
      + 'being put back. Nothing was overwritten: the location it moved into was empty.';
    try {
      // The SQLite live path is a file with `-wal`/`-shm` siblings; the PGLite
      // one is a directory. Which we are looking at is decided by the observed
      // entry, not by a flag we would have had to read from the journal.
      if (restorable === observed.sqlite) fsPort.renameWithSidecars(from, restorable.livePath);
      else fsPort.rename(from, restorable.livePath);
      quarantineUnreadableJournal(userDataPath, log);
      log('warn', `[Recovery] ${message}`);
      return {
        plan: {
          action: 'restore_displaced',
          reason: 'journal_unreadable',
          moveFrom: from,
          moveTo: restorable.livePath,
          blockDatabaseOpen: false,
          message,
        },
        applied: true,
        error: null,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log('error', '[Recovery] Could not put the displaced database back', err);
      return {
        plan: {
          action: 'hold_unreadable_journal',
          reason: 'journal_unreadable',
          moveFrom: null,
          moveTo: null,
          blockDatabaseOpen: true,
          message:
            'A recovery was interrupted and Nimbalyst could not put the previous database back '
            + `(${error}). It will not create an empty one on top of it. Every copy is still on `
            + 'disk; the restore option on this dialog can put one back.',
        },
        applied: false,
        error,
      };
    }
  }

  const blocked = acting.length > 0;
  return {
    plan: {
      action: 'hold_unreadable_journal',
      reason: 'journal_unreadable',
      moveFrom: null,
      moveTo: null,
      blockDatabaseOpen: blocked,
      message: blocked
        ? 'A recovery was interrupted and its record is damaged, so Nimbalyst cannot tell which '
          + 'copy of your database is which. There is no database at the usual location, so it '
          + `will not create an empty one on top of the copies beside it (${detail}). Every copy `
          + 'is still on disk; the restore option on this dialog lists them.'
        : 'A recovery left a damaged record behind. The database at the usual location is '
          + 'untouched and every recovery copy is still on disk; Settings > Database lists them.',
    },
    applied: false,
    error: detail,
  };
}

/**
 * Move the unreadable journal aside instead of deleting it. Leaving it in place
 * would make every later launch re-run this scan and log a failure about a
 * situation that has been resolved; deleting it would destroy the only record
 * that a recovery ran. A failure here is not worth failing a boot over -- the
 * cost is one redundant scan next launch.
 */
function quarantineUnreadableJournal(
  userDataPath: string,
  log: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void,
): void {
  const from = getRecoveryJournalPath(userDataPath);
  const to = `${from}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(from, to);
  } catch (err) {
    log('warn', '[Recovery] Could not move the unreadable journal aside', { from, to, err });
  }
}
