/**
 * The durable record of a recovery in progress.
 *
 * `runRecoveryTransaction` has one window where the app has no database: the
 * live store has been renamed to `*.displaced-*` and the verified replacement
 * has not been renamed into its place yet. Before this file existed, a process
 * killed inside that window left nothing behind, and the next launch saw an
 * absent `pglite-db/` and created an empty one on top -- the precise sequence
 * that made #1347 irreversible for the three installs that then migrated the
 * empty database.
 *
 * So the transaction writes down what it is about to do, and where every copy
 * will be, before it moves anything, and records each phase as it completes.
 * Startup reads the journal rather than guessing from which directories
 * happen to exist: `recoveryReconciler.ts` turns (journal + observed facts)
 * into a plan whose paths always come from what was written down.
 *
 * This is deliberately a sibling of `sqlite/cutoverJournal.ts` rather than a
 * reuse of it. The two operations journal different things -- a cutover
 * records a backend-flag change and a source it may have to hand back to a
 * different engine; a recovery records three copies of one backend's database
 * and never changes which backend is active -- and collapsing them would mean
 * one schema with half its fields inapplicable on either path. They do share
 * the rule that matters: atomic-replace writes, because a torn journal reads
 * back as "nothing was running", which is the worst possible answer.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ActiveBackend } from './types';

/**
 * Phases, in order. Each is written only after the work it names has actually
 * happened, so a journal at phase N means "N is done, N+1 may or may not have
 * started". The interesting entry is `live_displaced`: a journal sitting there
 * is the app announcing that it has no database right now and naming the two
 * places the data could be.
 *
 *   prepared           journal exists; nothing has moved
 *   snapshot_taken     a verified pre-restore copy of the live database exists
 *   staged_verified    the replacement is staged and has passed full validation
 *   live_displaced     the live database has been renamed to `displacedPath`
 *   promoted           the staged replacement now sits at `livePath`
 *   reopened_verified  the replacement opened and read back what we expect
 */
export const RECOVERY_PHASES = [
  'prepared',
  'snapshot_taken',
  'staged_verified',
  'live_displaced',
  'promoted',
  'reopened_verified',
] as const;

export type RecoveryPhase = (typeof RECOVERY_PHASES)[number];

export function recoveryPhaseIndex(phase: RecoveryPhase): number {
  return RECOVERY_PHASES.indexOf(phase);
}

export interface RecoveryJournalPaths {
  /** Where the app opens its database from. */
  livePath: string;
  /** Where the replacement is built and verified before the swap. */
  stagingPath: string;
  /** Where the live database is moved to. Never deleted by any code. */
  displacedPath: string;
  /** Verified copy taken before anything moved, or null when live was absent. */
  preRestoreSnapshotPath: string | null;
  /** The artifact or backup being recovered from. Never modified. */
  sourceArtifactPath: string;
}

export interface RecoveryJournal {
  /** Bumped only on an incompatible shape change; an unknown version holds. */
  version: 1;
  operationId: string;
  candidateId: string;
  backend: ActiveBackend;
  startedAt: string;
  updatedAt: string;
  phase: RecoveryPhase;
  /**
   * How many launches have tried to reconcile this journal. A recovery that
   * cannot be finished or undone must stop trying rather than relaunch into
   * the same rename forever.
   */
  reconcileAttempts: number;
  /**
   * Whether there was a live database when the transaction started. A fresh
   * install recovering into an empty slot has nothing to displace, and
   * "displaced is missing" must not read as loss in that case.
   */
  liveExisted: boolean;
  paths: RecoveryJournalPaths;
}

/** Three launches, matching the cutover reconciler. */
export const MAX_RECOVERY_RECONCILE_ATTEMPTS = 3;

const JOURNAL_FILE_NAME = 'database-recovery.json';

export function getRecoveryJournalPath(userDataPath: string): string {
  return path.join(userDataPath, JOURNAL_FILE_NAME);
}

/**
 * Temp file + rename, so a reader sees either the whole previous value or the
 * whole new one. Same standard as the cutover journal and the backend flag.
 */
function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Three outcomes, and the difference between the last two is the point.
 *
 * `absent` means no recovery was running. `unreadable` means one was and we
 * cannot tell what it was doing -- a torn write, a version this build predates,
 * a file the OS will not hand over, a record that names none of its paths.
 *
 * These used to collapse into a single `null`, on a comment claiming
 * `cutoverJournal.ts` as precedent. It says the opposite: `readCutoverJournalStatus`
 * separates the two and `reconcileCutoverOnStartup` fails closed on `unreadable`,
 * because inferring from the directory listing during a cutover means trusting
 * exactly the thing that lies. The same is true here, and worse: a recovery
 * interrupted at `live_displaced` has NO database at the live path, so "nothing
 * to do" means startup creates an empty one on top of the displaced copy. That
 * is #1347's ending reached a second way, and a truncated JSON file is all it
 * takes.
 */
export type RecoveryJournalRead =
  | { status: 'absent' }
  | { status: 'unreadable'; detail: string }
  | { status: 'ok'; journal: RecoveryJournal };

export function readRecoveryJournalStatus(userDataPath: string): RecoveryJournalRead {
  let raw: string;
  try {
    raw = fs.readFileSync(getRecoveryJournalPath(userDataPath), 'utf-8');
  } catch (err) {
    // Only "the file is not there" is absent. A permissions or I/O error on a
    // journal that does exist is the unreadable case; reading it as absent
    // would be the same fail-open by a different route.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'unreadable', detail: `journal could not be read: ${(err as Error).message}` };
  }
  let parsed: RecoveryJournal;
  try {
    parsed = JSON.parse(raw) as RecoveryJournal;
  } catch (err) {
    return { status: 'unreadable', detail: `journal is not valid JSON: ${(err as Error).message}` };
  }
  if (parsed?.version !== 1) {
    return {
      status: 'unreadable',
      detail: `journal version ${String(parsed?.version)} is not one this build understands`,
    };
  }
  if (!RECOVERY_PHASES.includes(parsed.phase)) {
    return { status: 'unreadable', detail: `journal phase ${String(parsed.phase)} is not a known phase` };
  }
  if (!parsed.paths?.livePath || !parsed.paths?.displacedPath || !parsed.paths?.stagingPath) {
    return { status: 'unreadable', detail: 'journal does not name all of its paths' };
  }
  return { status: 'ok', journal: parsed };
}

/** The journal when it is readable, and `null` for both other outcomes. */
export function readRecoveryJournal(userDataPath: string): RecoveryJournal | null {
  const read = readRecoveryJournalStatus(userDataPath);
  return read.status === 'ok' ? read.journal : null;
}

export function writeRecoveryJournal(userDataPath: string, journal: RecoveryJournal): void {
  writeJsonAtomic(getRecoveryJournalPath(userDataPath), {
    ...journal,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Drop the journal. Only called once the recovery has reached a state that
 * needs no further action -- finished, fully undone, or never started. This
 * destroys the record of where the copies went, not the copies, but that is
 * still enough to be worth keeping the caller count small.
 */
export function clearRecoveryJournal(userDataPath: string): void {
  try {
    fs.rmSync(getRecoveryJournalPath(userDataPath), { force: true });
  } catch {
    // A stale journal costs one idempotent reconcile next launch. Failing the
    // boot over it is not a trade worth making.
  }
}

/**
 * What `runRecoveryTransaction` writes through. Injected so the transaction
 * does not need to know where userData is, and so a test can drive the phase
 * sequence without a second real file.
 */
export interface RecoveryJournalPort {
  /** Write the journal at `prepared`, before the first destructive step. */
  begin(entry: Omit<RecoveryJournal, 'version' | 'startedAt' | 'updatedAt' | 'phase' | 'reconcileAttempts'>): void;
  /** Record that `phase` is now complete, optionally filling in a path. */
  advance(phase: RecoveryPhase, paths?: Partial<RecoveryJournalPaths>): void;
  /** Remove the journal. */
  clear(): void;
}

/**
 * Thrown by `begin()` when a journal from an unfinished recovery is already on
 * disk. Typed so `runRecoveryTransaction` can turn it into a refusal instead of
 * an exception, and so a caller sweeping several backups can tell it apart from
 * an ordinary I/O failure.
 */
export class RecoveryInProgressError extends Error {
  constructor(readonly detail: string) {
    super(
      'A previous recovery has not been resolved and its journal is the only record of where '
      + `that database went (${detail}). Restart Nimbalyst so startup can finish or undo it `
      + 'before starting another recovery. Every copy is still on disk.',
    );
    this.name = 'RecoveryInProgressError';
  }
}

/** The production port: one JSON file at the userData root. */
export function createRecoveryJournalPort(userDataPath: string): RecoveryJournalPort {
  let current: RecoveryJournal | null = null;
  return {
    begin(entry) {
      // Refuse to write over a journal this port did not write.
      //
      // The journal is the ONLY record of where a displaced database went; the
      // copy itself carries a timestamp and nothing that says it is live data.
      // A sweep that tried the next backup after a post-swap failure called
      // `begin()` again, that overwrote the first attempt's record, and the
      // second attempt -- seeing `liveExisted === false` -- failed and cleared
      // its own journal on the way out. The user's database was then sitting
      // under a `.displaced-*` name with nothing pointing at it. Falling back
      // is safe after a pre-swap refusal, which leaves no journal; it is never
      // safe on top of one.
      const existing = readRecoveryJournalStatus(userDataPath);
      if (existing.status === 'ok' && existing.journal.operationId !== entry.operationId) {
        throw new RecoveryInProgressError(`unfinished recovery at phase ${existing.journal.phase}`);
      }
      if (existing.status === 'unreadable') {
        throw new RecoveryInProgressError(existing.detail);
      }
      const now = new Date().toISOString();
      current = {
        version: 1,
        startedAt: now,
        updatedAt: now,
        phase: 'prepared',
        reconcileAttempts: 0,
        ...entry,
      };
      writeRecoveryJournal(userDataPath, current);
    },
    advance(phase, paths) {
      if (!current) return;
      current = {
        ...current,
        phase,
        paths: paths ? { ...current.paths, ...paths } : current.paths,
      };
      writeRecoveryJournal(userDataPath, current);
    },
    clear() {
      current = null;
      clearRecoveryJournal(userDataPath);
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem port
// ---------------------------------------------------------------------------

/**
 * The three filesystem operations the reconciler needs. Real by default; this
 * exists so a test can make one specific rename fail without replacing the
 * filesystem under code whose whole job is filesystem atomicity.
 */
export interface RecoveryFsPort {
  exists(target: string): boolean;
  rename(from: string, to: string): void;
  /** Sidecars better-sqlite3 leaves next to a database file. */
  renameWithSidecars(from: string, to: string): void;
}

export const realRecoveryFs: RecoveryFsPort = {
  exists: (target) => fs.existsSync(target),
  rename: (from, to) => fs.renameSync(from, to),
  renameWithSidecars: (from, to) => {
    const moved: [string, string][] = [];
    try {
      fs.renameSync(from, to);
      moved.push([from, to]);
      for (const suffix of ['-wal', '-shm']) {
        if (!fs.existsSync(`${from}${suffix}`)) continue;
        fs.renameSync(`${from}${suffix}`, `${to}${suffix}`);
        moved.push([`${from}${suffix}`, `${to}${suffix}`]);
      }
    } catch (err) {
      // Undo whatever landed. A half-moved database -- main file at the
      // destination, WAL still at the source -- is the one outcome that is
      // worse than either end state, because SQLite will open the main file
      // and silently ignore the journal that holds the newest writes.
      for (const [src, dest] of moved.reverse()) {
        try {
          fs.renameSync(dest, src);
        } catch {
          // Nothing further to try; the caller reports failure and every copy
          // is still on disk under a name the journal recorded.
        }
      }
      throw err;
    }
  },
};
