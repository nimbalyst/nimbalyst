// @vitest-environment node
/**
 * Restore must never be the thing that loses the data.
 *
 * Both backup services used to restore by closing the database, `fs.rm`-ing the
 * live copy, and only then copying the candidate over the hole. Two failures
 * fall straight out of that order, and both are #1347's shape:
 *
 *   - a candidate that verifies "valid" but is empty replaces a populated live
 *     database, and the app comes back up looking healthy with nothing in it;
 *   - a crash between the remove and the copy leaves no database at all.
 *
 * These tests drive the real services over real files in a temp directory. No
 * `fs` mocking: the claim under test is about what survives on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Sqlite from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmp: string;
// `getAppPath` and `isPackaged` are what the production-constructed verifier
// resolves the PGLite worker bundle from; without them it dies before it can
// spawn anything, and the test below could not tell that apart from a verdict.
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd(), isPackaged: false },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: () => {}, warn: () => {}, error: () => {} } },
}));

import { DatabaseBackupService } from '../DatabaseBackupService';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { SQLiteBackupService } from '../SQLiteBackupService';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');

// ---------------------------------------------------------------------------
// PGLite side. A "database" here is a directory whose session count lives in a
// marker file; the real service delegates every content judgement to the
// worker, so the worker stub is the honest seam.
// ---------------------------------------------------------------------------

function writePgliteDir(dir: string, sessionCount: number): void {
  fs.mkdirSync(path.join(dir, 'base'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PG_VERSION'), '15\n');
  fs.writeFileSync(path.join(dir, 'sessions.marker'), String(sessionCount));
  fs.writeFileSync(path.join(dir, 'base', 'payload'), 'x'.repeat(1024 * sessionCount + 1));
}

function readSessionMarker(dir: string): number {
  return Number(fs.readFileSync(path.join(dir, 'sessions.marker'), 'utf-8'));
}

/**
 * Stands in for PGLiteDatabaseWorker. Every answer is derived from the marker
 * file actually on disk, so the fake cannot report a state the filesystem
 * does not have — which is the only thing that makes it worth testing against.
 */
function makePgWorker(livePath: string) {
  return {
    initialize: vi.fn(async () => {}),
    isInitialized: () => true,
    close: vi.fn(async () => {}),
    queryReadOnly: vi.fn(async (sql: string) => {
      const c = sql.includes('ai_sessions') ? readSessionMarker(livePath) : 0;
      return { rows: [{ c }] };
    }),
    verifyBackup: vi.fn(async (p: string) => {
      const sessionCount = readSessionMarker(p);
      return { valid: true, hasData: sessionCount > 0, sessionCount, historyCount: 0 };
    }),
  };
}

/** The recovery-shaped verifier the service now takes, over the same markers. */
function markerVerifier(dbPath: string) {
  try {
    const sessionCount = readSessionMarker(dbPath);
    return Promise.resolve({
      valid: true,
      integrity: 'not-applicable' as const,
      requiredSchemaPresent: true,
      // Zero, not one: these fixture "databases" carry a session marker and
      // nothing else, and the emptiness gate counts projects now. A fixture
      // that reported a project the store does not have would make the
      // empty-candidate test below pass for the wrong reason.
      indicators: { sessionCount, documentHistoryCount: 0, projectCount: 0 },
    });
  } catch (err) {
    return Promise.resolve({
      valid: false,
      integrity: 'unreadable' as const,
      requiredSchemaPresent: false,
      indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
      error: (err as Error).message,
    });
  }
}

describe('DatabaseBackupService restore (PGLite)', () => {
  let livePath: string;
  let backupDir: string;
  let svc: DatabaseBackupService;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-restore-pg-'));
    livePath = path.join(tmp, 'pglite-db');
    backupDir = path.join(tmp, 'db-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    writePgliteDir(livePath, 42);
    svc = new DatabaseBackupService(livePath, makePgWorker(livePath) as never, {
      verifyDatabaseAt: markerVerifier,
    });
    await svc.initialize();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // The exact #1347 conversion step: a structurally-valid but empty copy is
  // allowed to replace two months of history because every check asked "is
  // this file well-formed?" and none asked "is there anything in it?".
  it('refuses an empty candidate and leaves the live database untouched', async () => {
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-current'), 0);

    const result = await svc.restoreFromBackup();

    expect(result.success).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true);
    expect(readSessionMarker(livePath)).toBe(42);
  });

  it('preserves the displaced live database after a successful restore', async () => {
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-current'), 99);

    const result = await svc.restoreFromBackup();

    expect(result.success).toBe(true);
    expect(readSessionMarker(livePath)).toBe(99);

    // The database we just replaced is still the user's only copy of whatever
    // it held. It must survive the restore under a name they can find.
    const displaced = fs
      .readdirSync(tmp)
      .filter((n) => n.startsWith('pglite-db.') && n !== path.basename(livePath))
      .map((n) => path.join(tmp, n))
      .filter((p) => fs.existsSync(path.join(p, 'sessions.marker')));
    expect(displaced.map(readSessionMarker)).toContain(42);
  });

  /**
   * Slot order is recency, and recency is the wrong tiebreaker for the failure
   * this path undoes. #1347's shape is a database that lost its contents and
   * was then backed up on schedule, which leaves a small, valid, recent
   * `current` sitting in front of a `previous` holding months of history.
   * Taking the first non-empty slot restored the small one, reported success,
   * and never looked at the richer copy again.
   */
  it('restores the richest backup, not the newest', async () => {
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-current'), 1);
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-previous'), 300);

    const result = await svc.restoreFromBackup();

    expect(result.success).toBe(true);
    expect(result.source).toBe('previous');
    expect(readSessionMarker(livePath)).toBe(300);
  });

  it('still prefers the newer slot when both hold the same amount', async () => {
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-current'), 50);
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-previous'), 50);

    const result = await svc.restoreFromBackup();

    expect(result.source).toBe('current');
  });
});

/**
 * The sweep across several backups, and where it has to stop.
 *
 * `restoreFromBackup` tries each copy in turn. That is right while nothing has
 * moved -- a copy that fails verification should not end the attempt. It is
 * wrong the moment a copy gets as far as the swap, because the journal is the
 * only record of where the displaced database went and the next attempt's
 * `begin()` overwrote it. On a persistent promote failure that produced:
 * attempt one displaces the live database and fails, attempt two overwrites its
 * journal, attempt two sees no live database, fails, and clears the journal on
 * its way out -- leaving the user's database under a `.displaced-*` name with
 * nothing pointing at it.
 *
 * The swap boundary is not reachable by feeding the service different files, so
 * `beforeRecoveryStep` injects the fault at the exact step. Everything else is
 * real: real directories, real renames, the real sweep.
 */
describe('DatabaseBackupService restore sweep', () => {
  let livePath: string;
  let backupDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-restore-sweep-'));
    livePath = path.join(tmp, 'pglite-db');
    backupDir = path.join(tmp, 'db-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    writePgliteDir(livePath, 42);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const journalPath = () => path.join(tmp, 'database-recovery.json');

  it('stops after an attempt that reached the swap, and keeps that attempt\'s journal', async () => {
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-current'), 99);
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-previous'), 50);
    const steps: string[] = [];
    const svc = new DatabaseBackupService(livePath, makePgWorker(livePath) as never, {
      verifyDatabaseAt: markerVerifier,
      beforeRecoveryStep: (step) => {
        steps.push(step);
        if (step === 'swap-displace') throw new Error('EPERM: rename blocked');
      },
    });
    await svc.initialize();

    const result = await svc.restoreFromBackup();

    expect(result.success).toBe(false);
    // One attempt, not two. `quiesce` runs once per candidate that starts, and
    // the reported failure names only the copy that was actually tried.
    expect(steps.filter((s) => s === 'quiesce')).toHaveLength(1);
    expect(result.error).toContain('current:');
    expect(result.error).not.toContain('previous:');
    // The journal still belongs to the attempt that moved something.
    const journal = JSON.parse(fs.readFileSync(journalPath(), 'utf-8'));
    expect(journal.operationId).toContain('backup-restore-current');
    // And the live database is exactly where it was.
    expect(readSessionMarker(livePath)).toBe(42);
  });

  it('still falls through to the next copy when the first fails before anything moves', async () => {
    // `current` is the bigger copy, so it is tried first, and it is empty --
    // rejected at `verify`, before the swap. `previous` holds real content.
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-current'), 0);
    fs.writeFileSync(
      path.join(backupDir, 'pglite-db.backup-current', 'base', 'filler'),
      'x'.repeat(500_000),
    );
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-previous'), 300);
    const svc = new DatabaseBackupService(livePath, makePgWorker(livePath) as never, {
      verifyDatabaseAt: markerVerifier,
    });
    await svc.initialize();

    const result = await svc.restoreFromBackup();

    expect(result).toMatchObject({ success: true, source: 'previous' });
    expect(readSessionMarker(livePath)).toBe(300);
    // A completed restore leaves no journal for the next launch to reconcile.
    expect(fs.existsSync(journalPath())).toBe(false);
  });
});

/**
 * The constructor `initialize.ts` actually uses.
 *
 * `verifyDatabaseAt` was optional and the sole production call site never
 * passed it, so `restoreFromPath` hit its fail-closed branch and every shipped
 * `restoreFromBackup()` returned "No database verifier configured". The whole
 * rolling-backup restore path was dead in released builds, and every test that
 * covered it passed its own verifier in and so could not see that.
 */
describe('DatabaseBackupService as production constructs it', () => {
  let livePath: string;
  let backupDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-restore-prod-'));
    livePath = path.join(tmp, 'pglite-db');
    backupDir = path.join(tmp, 'db-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    writePgliteDir(livePath, 42);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * The previous version of this asserted only that an obsolete "No database
   * verifier configured" string was absent, which is true of any failure at
   * all -- including the whole period when the verifier crashed on spawn.
   *
   * What is deterministic here, and worth asserting, is that the production
   * construction does not skip verification. These fixtures are directories
   * with a marker file rather than real PGLite stores, so a service that
   * verified anything at all must refuse them; a service that skipped
   * verification would sail through and replace the live database with one.
   * The failure has to name the verification, and the live database has to
   * still be there afterwards.
   *
   * That the verifier can actually START is asserted deterministically in
   * `recovery/__tests__/pgliteVerification.test.ts`, over real worker threads.
   * It is deliberately not asserted here: this test would have to depend on
   * `out/worker.bundle.js`, which is a build artifact.
   */
  it('verifies before it replaces anything, with the verifier it built itself', async () => {
    // Exactly the options `initialize.ts` supplies: a retention getter, and
    // nothing else.
    const svc = new DatabaseBackupService(livePath, makePgWorker(livePath) as never, {
      getCopiesKept: () => 2,
    });
    await svc.initialize();
    writePgliteDir(path.join(backupDir, 'pglite-db.backup-current'), 99);

    const result = await svc.restoreFromBackup();

    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('did not verify');
    // And the live database is untouched either way.
    expect(readSessionMarker(livePath)).toBe(42);
    // Nothing reached the swap, so there is no journal for startup to resolve.
    expect(fs.existsSync(path.join(tmp, 'database-recovery.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SQLite side. Real better-sqlite3 databases, real online backups.
// ---------------------------------------------------------------------------

async function seedSessions(db: SQLiteDatabase, ids: string[]): Promise<void> {
  const handle = db.getRawHandle()!;
  const stmt = handle.prepare('INSERT INTO ai_sessions(id, provider) VALUES (?, ?)');
  for (const id of ids) stmt.run(id, 'claude');
}

/**
 * Read through a throwaway raw handle rather than `SQLiteDatabase`, which
 * would run migrations against a file we only want to look at.
 */
function sessionCountOf(file: string): number {
  const handle = new Sqlite(file, { fileMustExist: true, readonly: true });
  try {
    return (handle.prepare('SELECT COUNT(*) AS c FROM ai_sessions').get() as { c: number }).c;
  } finally {
    handle.close();
  }
}

describe('SQLiteBackupService restore', () => {
  let sqliteDir: string;
  let backupDir: string;
  let sqlite: SQLiteDatabase;
  let svc: SQLiteBackupService;
  let livePath: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-restore-sq-'));
    sqliteDir = path.join(tmp, 'sqlite-db');
    backupDir = path.join(tmp, 'sqlite-db.backups');
    fs.mkdirSync(sqliteDir, { recursive: true });
    livePath = path.join(sqliteDir, 'nimbalyst.sqlite');

    sqlite = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await sqlite.initialize();
    await seedSessions(sqlite, ['live-1', 'live-2', 'live-3']);

    svc = new SQLiteBackupService({ sqliteDir, backupDir, sqlite });
    await svc.initialize();
  });

  afterEach(async () => {
    try { await sqlite.close(); } catch { /* already closed by a restore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses an empty candidate and leaves the live database untouched', async () => {
    // A schema-only database: `quick_check` says ok, `hasData` says false.
    const emptyDir = path.join(tmp, 'empty-src');
    fs.mkdirSync(emptyDir, { recursive: true });
    const empty = new SQLiteDatabase({ dbDir: emptyDir, schemaDir: SCHEMA_DIR });
    await empty.initialize();
    await empty.close();
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(
      path.join(emptyDir, 'nimbalyst.sqlite'),
      path.join(backupDir, 'nimbalyst.backup-current.sqlite'),
    );

    const result = await svc.restoreFromBackup();

    expect(result.success).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true);
    expect(sessionCountOf(livePath)).toBe(3);
  });

  it('preserves the displaced live database after a successful restore', async () => {
    const richDir = path.join(tmp, 'rich-src');
    fs.mkdirSync(richDir, { recursive: true });
    const rich = new SQLiteDatabase({ dbDir: richDir, schemaDir: SCHEMA_DIR });
    await rich.initialize();
    await seedSessions(rich, ['a', 'b', 'c', 'd', 'e', 'f']);
    await rich.close();
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(
      path.join(richDir, 'nimbalyst.sqlite'),
      path.join(backupDir, 'nimbalyst.backup-current.sqlite'),
    );

    const result = await svc.restoreFromBackup();

    expect(result.success).toBe(true);
    expect(sessionCountOf(livePath)).toBe(6);

    const displaced = fs
      .readdirSync(sqliteDir)
      .filter((n) => n.endsWith('.sqlite') && n !== 'nimbalyst.sqlite')
      .map((n) => path.join(sqliteDir, n));
    expect(displaced.map(sessionCountOf)).toContain(3);
  });
});
