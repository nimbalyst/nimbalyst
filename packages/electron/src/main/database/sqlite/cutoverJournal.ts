/**
 * The durable record of a PGLite -> SQLite cutover in progress.
 *
 * Migration and adoption are the same operation once the copying is done:
 * quiesce the source, move it aside, point the backend flag at the target.
 * That sequence has a window in which the source is no longer where the app
 * looks for it and the flag does not yet say so. A process that dies inside
 * that window used to leave nothing behind, and the next launch inferred what
 * had happened from which directories existed -- which is how #1347 turned a
 * moved-aside store into an empty one.
 *
 * This file is the fix for the inference. Before the first destructive step we
 * write down what we are about to do and where every copy will be, and each
 * phase transition is recorded before the next one begins. Startup then reads
 * the journal rather than the directory listing: `cutoverReconciler.ts` turns
 * (journal + observed facts) into a plan, and the plan names paths this file
 * recorded, never paths derived from a naming convention.
 *
 * Writes are atomic-replace (temp file + rename). A torn journal is worse than
 * no journal, because a torn journal reads back as "no cutover was running".
 */

import * as fs from 'fs';
import * as path from 'path';

import type { BackendState, DatabaseBackend } from './BackendSelector';

/**
 * The six phases, in order. Each one is written only after the work it names
 * has actually happened, so a journal at phase N means "N is done, N+1 may or
 * may not have started".
 *
 *   prepared          journal exists; nothing destructive has happened yet
 *   target_verified   the SQLite target is complete and independently checked
 *   source_quiesced   PGLite is closed; the source directory is still in place
 *   source_preserved  the source has been renamed to `source.preservedPath`
 *   backend_committed the backend flag points at SQLite
 *   reopened_verified the new backend opened and read back what we expect
 */
export const CUTOVER_PHASES = [
  'prepared',
  'target_verified',
  'source_quiesced',
  'source_preserved',
  'backend_committed',
  'reopened_verified',
] as const;

export type CutoverPhase = (typeof CUTOVER_PHASES)[number];

export function phaseIndex(phase: CutoverPhase): number {
  return CUTOVER_PHASES.indexOf(phase);
}

/** Is `a` at or past `b` in the phase order? */
export function phaseAtLeast(a: CutoverPhase, b: CutoverPhase): boolean {
  return phaseIndex(a) >= phaseIndex(b);
}

/**
 * Cheap evidence that the directory we are about to move is the one we
 * journaled. Not a checksum -- reading a multi-gigabyte store twice to prove
 * it did not change is not a trade this path can make. Entry count, total
 * bytes and newest mtime are enough to notice that something else replaced the
 * directory between the journal write and the reconcile.
 */
export interface CutoverSourceFingerprint {
  entryCount: number;
  totalBytes: number;
  newestMtimeMs: number;
}

export interface CutoverJournal {
  /** Bumped only if the shape changes incompatibly; an unknown version holds. */
  version: 1;
  operationId: string;
  /**
   * `rollback` is the same five steps run the other way: quiesce SQLite,
   * move `sqlite-db/` aside, promote the preserved PGLite store back into
   * place, point the flag at PGLite. It is journaled here rather than in a
   * journal of its own because every interruption it can suffer is one this
   * file already describes and `cutoverReconciler.ts` already resolves --
   * `source` is simply the store being retired and `target` the one becoming
   * live, which is true in both directions.
   */
  operation: 'migrate' | 'adopt' | 'rollback';
  startedAt: string;
  updatedAt: string;
  phase: CutoverPhase;
  /**
   * How many times startup has tried to reconcile this journal. A cutover that
   * cannot be finished or rolled back must stop asking rather than relaunch
   * forever; see `MAX_RECONCILE_ATTEMPTS`.
   */
  reconcileAttempts: number;
  source: {
    /** Absolute path the app opens PGLite from. */
    livePath: string;
    /** Absolute path the source is preserved at. Never deleted by any code. */
    preservedPath: string;
    fingerprint: CutoverSourceFingerprint;
  };
  /** How the backend flag records this cutover, including when startup finishes it. */
  commitSetBy: 'user-migration' | 'auto-migration';
  /**
   * Which backend the commit step names. Absent means `sqlite`, which is what
   * every forward cutover writes; a rollback sets it to `pglite`. Everything
   * that reads the journal derives "which store is the source" from this, so
   * a reconciler never has to know whether it is looking at a migration or a
   * rollback to work out which directory must not be recreated empty.
   */
  commitBackend?: DatabaseBackend;
  target: {
    /** Absolute path the app opens SQLite from once this cutover lands. */
    livePath: string;
    /**
     * Adoption only: the already-populated directory that gets renamed into
     * `livePath`. Absent for a migration, which builds its target in place.
     */
    stagingPath?: string;
  };
  rollback: {
    backendBefore: DatabaseBackend;
    /** The whole prior flag file, or null when there was none. */
    stateBefore: BackendState | null;
  };
}

/**
 * Three startup attempts, matching the auto-migration back-off. Past this the
 * reconciler holds and leaves every copy in place for a human.
 */
export const MAX_RECONCILE_ATTEMPTS = 3;

const JOURNAL_FILE_NAME = 'database-cutover.json';

export function getCutoverJournalPath(userDataPath: string): string {
  return path.join(userDataPath, JOURNAL_FILE_NAME);
}

/**
 * Write a JSON file so a reader either sees the whole previous value or the
 * whole new one. Shared with `BackendSelector.writeBackendState` -- the flag
 * file and the journal have to hold to the same standard, because a cutover
 * that survives a torn journal and then tears the flag file has not gained
 * anything.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Three outcomes, and the difference between the last two is the point.
 *
 * `absent` means no cutover was running. `unreadable` means one was running
 * and we cannot tell what it was doing -- a torn write, a version this build
 * predates, a file the OS will not hand over. Collapsing those two into `null`
 * is failing open: the caller infers a backend from the directory listing, and
 * the directory listing during a cutover is exactly the thing that lies. If
 * source preservation had already happened, inference finds no `pglite-db/`
 * and creates an empty one on top of a perfectly good store parked aside.
 */
export type CutoverJournalRead =
  | { status: 'absent' }
  | { status: 'unreadable'; detail: string }
  | { status: 'ok'; journal: CutoverJournal };

export function readCutoverJournalStatus(userDataPath: string): CutoverJournalRead {
  const journalPath = getCutoverJournalPath(userDataPath);
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath, 'utf-8');
  } catch (err) {
    // Only "the file is not there" is absent. A permissions or I/O error on a
    // journal that does exist is the unreadable case, and reading it as absent
    // would be the same fail-open by a different route.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'unreadable', detail: `journal could not be read: ${(err as Error).message}` };
  }
  let parsed: CutoverJournal;
  try {
    parsed = JSON.parse(raw) as CutoverJournal;
  } catch (err) {
    return { status: 'unreadable', detail: `journal is not valid JSON: ${(err as Error).message}` };
  }
  if (parsed?.version !== 1) {
    return { status: 'unreadable', detail: `journal version ${String(parsed?.version)} is not one this build understands` };
  }
  if (!CUTOVER_PHASES.includes(parsed.phase)) {
    return { status: 'unreadable', detail: `journal phase ${String(parsed.phase)} is not a known phase` };
  }
  if (!parsed.source?.livePath || !parsed.source?.preservedPath || !parsed.target?.livePath) {
    return { status: 'unreadable', detail: 'journal does not name all of its paths' };
  }
  return { status: 'ok', journal: parsed };
}

/**
 * The journal, or null when there is nothing usable. Callers that must
 * distinguish "no cutover" from "a cutover I cannot understand" -- which is
 * every caller that is about to open a database -- use
 * `readCutoverJournalStatus` instead.
 */
export function readCutoverJournal(userDataPath: string): CutoverJournal | null {
  const read = readCutoverJournalStatus(userDataPath);
  return read.status === 'ok' ? read.journal : null;
}

export function writeCutoverJournal(userDataPath: string, journal: CutoverJournal): void {
  writeJsonAtomic(getCutoverJournalPath(userDataPath), {
    ...journal,
    updatedAt: new Date().toISOString(),
  });
}

/** Record that `phase` is now complete. */
export function advanceCutoverPhase(
  userDataPath: string,
  journal: CutoverJournal,
  phase: CutoverPhase,
): CutoverJournal {
  const next: CutoverJournal = { ...journal, phase, updatedAt: new Date().toISOString() };
  writeCutoverJournal(userDataPath, next);
  return next;
}

/**
 * Drop the journal. Only ever called once the cutover has reached a state that
 * needs no further action -- either finished, or fully rolled back. Removing a
 * journal is not destroying data, but it is destroying the record of where the
 * data went, so there are exactly two callers and both are in this package.
 */
export function clearCutoverJournal(userDataPath: string): void {
  try {
    fs.rmSync(getCutoverJournalPath(userDataPath), { force: true });
  } catch {
    // Leaving a stale journal costs one extra reconcile next launch, which is
    // idempotent. Failing the boot over it is not worth it.
  }
}

/**
 * Fingerprint a PGLite store directory. Top level only: the store is a Postgres
 * data directory with thousands of files under `base/`, and walking all of them
 * on every cutover is the repeated-directory-walk cost the plan calls out.
 */
export function fingerprintSource(dir: string): CutoverSourceFingerprint {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { entryCount: 0, totalBytes: 0, newestMtimeMs: 0 };
  }
  let totalBytes = 0;
  let newestMtimeMs = 0;
  for (const entry of entries) {
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      if (!stat.isDirectory()) totalBytes += stat.size;
      if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
    } catch {
      // A file that vanished mid-scan contributes nothing.
    }
  }
  return { entryCount: entries.length, totalBytes, newestMtimeMs };
}

export function fingerprintsMatch(
  a: CutoverSourceFingerprint,
  b: CutoverSourceFingerprint,
): boolean {
  return (
    a.entryCount === b.entryCount
    && a.totalBytes === b.totalBytes
    && Math.abs(a.newestMtimeMs - b.newestMtimeMs) < 1000
  );
}

// ---------------------------------------------------------------------------
// Filesystem port
// ---------------------------------------------------------------------------

/**
 * The handful of filesystem operations the cutover machine and the reconciler
 * perform. Defaults are the real ones; this exists so a test can make one
 * specific rename fail with `EPERM` -- the Windows file-lock case we cannot
 * reproduce on the machines we develop on -- without replacing the filesystem
 * underneath the rest of the operation, which would prove nothing about code
 * whose entire job is filesystem atomicity.
 */
export interface CutoverFs {
  exists(target: string): boolean;
  rename(from: string, to: string): void;
  isNonEmptyDir(target: string): boolean;
}

export const realCutoverFs: CutoverFs = {
  exists: (target) => fs.existsSync(target),
  rename: (from, to) => fs.renameSync(from, to),
  isNonEmptyDir: (target) => {
    try {
      return fs.statSync(target).isDirectory() && fs.readdirSync(target).length > 0;
    } catch {
      return false;
    }
  },
};
