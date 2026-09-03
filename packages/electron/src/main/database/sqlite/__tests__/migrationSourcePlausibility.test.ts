// @vitest-environment node
/**
 * NIM-3632: the migration copied 5, 14 and 204 rows out of PGLite stores that
 * had already been emptied, and reported success. Every gate we had compared
 * the target against the source, so an empty source passed all of them --
 * expected 0, got 0, no drift. This is the check that asks the question none
 * of those could: was the source plausibly the user's data?
 *
 * Each signal here comes from OUTSIDE the source database, which is the point.
 */

import { describe, it, expect } from 'vitest';
import { assessMigrationSource } from '../migrationSourcePlausibility';

const MB = 1024 * 1024;

/** An ordinary install: live database is the biggest thing on disk. */
const healthy = {
  liveDirBytes: 400 * MB,
  largestBackupBytes: 380 * MB,
  configuredProjectCount: 3,
  sourceSessionCount: 120,
};

describe('assessMigrationSource', () => {
  it('allows an ordinary install', () => {
    expect(assessMigrationSource(healthy).ok).toBe(true);
  });

  it('refuses when a backup dwarfs the live database', () => {
    // The #1347 fingerprint: the worker renamed the real database aside and
    // the app came up on a fresh empty one.
    const verdict = assessMigrationSource({
      ...healthy,
      liveDirBytes: 2 * MB,
      largestBackupBytes: 400 * MB,
      sourceSessionCount: 5,
    });

    expect(verdict).toMatchObject({
      ok: false,
      reasonCode: 'backup_dwarfs_live',
      reason: expect.stringMatching(/backup/i),
    });
  });

  it('refuses projects-without-sessions when a larger copy corroborates the loss', () => {
    // Someone with configured projects has used the app, and a bigger copy
    // sitting on disk says the store in front of us shrank. Either signal
    // alone is weak; together they are the #1347 fingerprint below the 3x bar.
    const verdict = assessMigrationSource({
      ...healthy,
      liveDirBytes: 200 * MB,
      largestBackupBytes: 260 * MB,
      sourceSessionCount: 0,
    });

    expect(verdict).toMatchObject({
      ok: false,
      reasonCode: 'projects_without_sessions',
      reason: expect.stringMatching(/session/i),
    });
  });

  it('allows projects-without-sessions when nothing on disk corroborates a loss', () => {
    // A real user can open folders and never start an AI session. With no
    // larger copy anywhere, "no sessions" is a usage pattern, not evidence
    // that this store is the wrong one -- and refusing it would strand a
    // legitimate install permanently.
    expect(assessMigrationSource({
      ...healthy,
      largestBackupBytes: 0,
      sourceSessionCount: 0,
    }).ok).toBe(true);
  });

  it('allows a genuinely new install with no projects and no sessions', () => {
    // A fresh install has nothing to lose, so there is nothing to protect.
    expect(assessMigrationSource({
      liveDirBytes: 8 * MB,
      largestBackupBytes: 0,
      configuredProjectCount: 0,
      sourceSessionCount: 0,
    }).ok).toBe(true);
  });

  it('blocks when the source session count could not be read', () => {
    // Inverted deliberately. This used to pass the migration through on the
    // grounds that "unreadable is not empty" -- true, but it is also not
    // "readable and fine", and the cutover it authorises is permanent. An
    // unreadable source is the one case where we know the least and are about
    // to do the most, so it fails closed. Safety invariant 8 in
    // nimbalyst-local/plans/pglite-to-sqlite-migration-retry.md.
    expect(assessMigrationSource({
      ...healthy,
      largestBackupBytes: 0,
      sourceSessionCount: null,
    })).toMatchObject({ ok: false, reasonCode: 'source_unreadable' });
  });

  it('ignores a backup that is merely a bit larger', () => {
    // Backups are taken at a point in time and routinely differ by a little.
    // Only a difference big enough to mean "this is a different database"
    // should stop a migration.
    expect(assessMigrationSource({
      ...healthy,
      liveDirBytes: 300 * MB,
      largestBackupBytes: 320 * MB,
    }).ok).toBe(true);
  });

  it('ignores a larger backup on a tiny install, where ratios are noise', () => {
    // 1 MB vs 4 MB is a 4x ratio and means nothing at this scale.
    expect(assessMigrationSource({
      liveDirBytes: 1 * MB,
      largestBackupBytes: 4 * MB,
      configuredProjectCount: 1,
      sourceSessionCount: 3,
    }).ok).toBe(true);
  });
});
