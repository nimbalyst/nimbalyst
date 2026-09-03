// @vitest-environment node
/**
 * Boot-time forced migration.
 *
 * The user-visible claim under test is "an install still on PGLite launches,
 * migrates without being asked, and comes up on SQLite with its data intact".
 * The first case proves that end to end against a real PGLite fixture and the
 * real orchestrator: after `maybeAutoMigrate` returns, `resolveBackend` must
 * independently agree that SQLite is now the backend, and the rows must be
 * readable from the SQLite file.
 *
 * The remaining cases drive the decision tree (flag gate, back-off, failure
 * fallback) through a stub orchestrator, because they are about *whether* the
 * migration runs, not about the copy itself. `PGLiteToSQLiteMigrator.test.ts`
 * and `MigrationOrchestrator.fixtureRoundtrip.test.ts` already own copy
 * correctness; this file must not re-prove it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { maybeAutoMigrate, type OrchestratorLike } from '../autoMigrate';
import {
  FIRST_COHORT_MAX_SOURCE_BYTES,
  type RolloutAuthorization,
} from '../rolloutAuthorization';
import {
  MIGRATION_ASSESSMENT_VERSION,
  getMigrationBlockedState,
  readBackendState,
  recordMigrationBlocked,
  resolveBackend,
  writeBackendState,
} from '../BackendSelector';
import { MigrationOrchestrator, type LivePgliteReader } from '../MigrationOrchestrator';
import type { PGLiteHandle } from '../PGLiteToSQLiteMigrator';
import { SQLiteDatabase } from '../SQLiteDatabase';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

let tmp: string;
let pgliteDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-auto-migrate-'));
  pgliteDir = path.join(tmp, 'pglite-db');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Minimal PGLite source. Deliberately two tables and a handful of rows: this
 * file proves the *trigger*, not the copy, so a big fixture would only buy
 * runtime.
 */
async function seedPglite(): Promise<void> {
  fs.mkdirSync(pgliteDir, { recursive: true });
  const db = new PGlite({ dataDir: pgliteDir });
  await (db as unknown as { waitReady: Promise<void> }).waitReady;
  await db.exec(`
    CREATE TABLE ai_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      provider TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New conversation',
      metadata JSONB NOT NULL DEFAULT '{}',
      is_archived BOOLEAN NOT NULL DEFAULT FALSE,
      is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO ai_sessions (id, provider, title) VALUES
      ('s1', 'claude-code', 'Survives the migration'),
      ('s2', 'claude-code', 'So does this one');
  `);
  await db.close();
}

function realOrchestrator(): OrchestratorLike {
  let live: PGlite | null = null;
  const reader: LivePgliteReader = {
    queryReadOnly: async <T,>(sql: string, params?: unknown[]) => {
      if (!live) {
        live = new PGlite({ dataDir: pgliteDir });
        await (live as unknown as { waitReady: Promise<void> }).waitReady;
      }
      return live.query<T>(sql, params) as Promise<{ rows: T[] }>;
    },
  };
  return new MigrationOrchestrator({
    userDataPath: tmp,
    schemaDir: SCHEMA_DIR,
    pglite: reader,
    closeRunningPglite: async () => {
      await live?.close();
      live = null;
    },
    reopenPgliteAfterClose: async (dataDir: string): Promise<PGLiteHandle> => {
      const db = new PGlite({ dataDir });
      await (db as unknown as { waitReady: Promise<void> }).waitReady;
      return {
        query: <T,>(sql: string, params?: unknown[]) =>
          db.query<T>(sql, params as unknown[]) as Promise<{ rows: T[] }>,
        exec: (sql: string) => db.exec(sql),
        close: () => db.close(),
      };
    },
  });
}

/** Stub for the decision-tree cases. `run` resolves or rejects on command. */
function stubOrchestrator(behavior: 'ok' | 'preflight-fail' | 'run-fail'): OrchestratorLike & {
  runCalls: number;
} {
  const stub = {
    runCalls: 0,
    async preflight() {
      return behavior === 'preflight-fail'
        ? { ok: false, reason: 'Not enough free disk space.', pgliteDirBytes: 10, freeBytes: 1, requiredBytes: 20 }
        : { ok: true, pgliteDirBytes: 10, freeBytes: 100, requiredBytes: 20 };
    },
    async run() {
      stub.runCalls += 1;
      if (behavior === 'run-fail') throw new Error('copy exploded');
      return { tablesMigrated: 1, targetRowCount: 2, durationMs: 5 } as never;
    },
  };
  return stub;
}

/**
 * Authorization stubs. The decision tree only ever sees the *result* of the
 * live evaluation, which is what makes these one line each; the evaluation
 * itself is proved in `rolloutAuthorization.test.ts`.
 */
function authorized(maxSourceBytes = FIRST_COHORT_MAX_SOURCE_BYTES): () => Promise<RolloutAuthorization> {
  return async () => ({
    authorized: true,
    snapshot: {
      enabled: true,
      maxSourceBytes,
      releaseChannel: 'alpha',
      configVersion: 'test-ramp',
      fetchedAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-09-03T00:00:00.000Z',
    },
  });
}

function unavailable(): () => Promise<RolloutAuthorization> {
  return async () => ({ authorized: false, reason: 'authorization_unavailable' });
}

function disabled(): () => Promise<RolloutAuthorization> {
  return async () => ({
    authorized: false,
    reason: 'rollout_disabled',
    configVersion: 'test-ramp',
  });
}

describe('maybeAutoMigrate', () => {
  it('migrates a PGLite install to SQLite and leaves the backend resolving to sqlite', async () => {
    await seedPglite();
    const relaunch = vi.fn();

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator: realOrchestrator(),
      relaunch,
    });

    expect(outcome.action).toBe('migrated');
    expect(relaunch).toHaveBeenCalledTimes(1);

    // The claim that matters: an independent re-resolution now says sqlite.
    expect(resolveBackend({ userDataPath: tmp }).backend).toBe('sqlite');
    expect(readBackendState(tmp)?.setBy).toBe('auto-migration');

    // Data survived, and the pre-migration store was preserved for rollback.
    const sqlite = new SQLiteDatabase({ dbDir: path.join(tmp, 'sqlite-db'), schemaDir: SCHEMA_DIR });
    await sqlite.initialize();
    const rows = await sqlite.query<{ id: string }>('SELECT id FROM ai_sessions ORDER BY id');
    expect(rows.rows.map((r) => r.id)).toEqual(['s1', 's2']);
    await sqlite.close();

    expect(fs.readdirSync(tmp).some((d) => d.startsWith('pglite-db.migrated-'))).toBe(true);
  }, 60_000);

  it('does not migrate when authorization cannot be obtained on this launch', async () => {
    await seedPglite();
    const orchestrator = stubOrchestrator('ok');

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: unavailable(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome).toMatchObject({
      action: 'skipped',
      reason: 'unauthorized',
      decision: { decision: 'stay_pglite', skipReason: 'authorization_unavailable' },
    });
    expect(orchestrator.runCalls).toBe(0);
    expect(resolveBackend({ userDataPath: tmp }).backend).toBe('pglite');
  });

  it('does not migrate when the rollout is remotely disabled', async () => {
    await seedPglite();
    const orchestrator = stubOrchestrator('ok');

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: disabled(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome).toMatchObject({
      action: 'skipped',
      reason: 'unauthorized',
      decision: { decision: 'stay_pglite', skipReason: 'rollout_disabled', configVersion: 'test-ramp' },
    });
    expect(orchestrator.runCalls).toBe(0);
  });

  it('leaves the user on PGLite and records the attempt when the migration fails', async () => {
    await seedPglite();
    const relaunch = vi.fn();

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator: stubOrchestrator('run-fail'),
      relaunch,
    });

    expect(outcome.action).toBe('failed');
    expect(relaunch).not.toHaveBeenCalled();
    expect(resolveBackend({ userDataPath: tmp }).backend).toBe('pglite');
    expect(readBackendState(tmp)?.migrationAttempts?.count).toBe(1);
  });

  it('stops auto-attempting after three consecutive failures', async () => {
    await seedPglite();
    writeBackendState(tmp, {
      backend: 'pglite',
      setAt: new Date().toISOString(),
      setBy: 'auto-migration-deferred',
      migrationAttempts: { count: 3, lastAttemptAt: new Date().toISOString(), lastErrorCode: 'unknown' },
    });
    const orchestrator = stubOrchestrator('ok');

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome).toMatchObject({
      action: 'skipped',
      reason: 'backed-off',
      decision: { decision: 'stay_pglite', skipReason: 'attempts_exhausted' },
    });
    expect(orchestrator.runCalls).toBe(0);
  });

  it('skips an install that is already on SQLite', async () => {
    fs.mkdirSync(path.join(tmp, 'sqlite-db'), { recursive: true });
    const orchestrator = stubOrchestrator('ok');

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome).toEqual({ action: 'skipped', reason: 'not-due' });
    expect(orchestrator.runCalls).toBe(0);
  });

  it('records a durable block instead of burning an attempt when the source is refused', async () => {
    // A refusal is a verdict about the data, not a failure of the machinery.
    // Counting it against the three transient attempts would silently retire
    // the install after three launches and leave nothing to show the user.
    // The error shape is written out longhand on purpose: this is what
    // actually crosses the SQLite worker boundary.
    await seedPglite();
    const refusal = {
      reasonCode: 'source_unreadable' as const,
      facts: {
        liveBytes: 'lt_256mib' as const,
        largestBackupBytes: 'none' as const,
        configuredProjects: '1_9' as const,
        sourceSessions: 'unknown' as const,
      },
      factsFingerprint: 'abc123def4567890',
      reason: 'The database could not be read.',
    };
    const refused = Object.assign(new Error(refusal.reason), {
      name: 'MigrationRefusedError',
      code: 'MIGRATION_REFUSED',
      data: refusal,
    });

    const orchestrator: OrchestratorLike & { runCalls: number } = {
      runCalls: 0,
      async preflight() {
        return { ok: true, pgliteDirBytes: 10, freeBytes: 100, requiredBytes: 20 };
      },
      async run() {
        orchestrator.runCalls += 1;
        throw refused;
      },
    };

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome).toMatchObject({ action: 'blocked', reasonCode: 'source_unreadable' });
    expect(readBackendState(tmp)?.migrationAttempts).toBeUndefined();
    expect(getMigrationBlockedState(tmp)).toMatchObject({
      reasonCode: 'source_unreadable',
      factsFingerprint: 'abc123def4567890',
    });
    expect(resolveBackend({ userDataPath: tmp }).backend).toBe('pglite');
  });

  it('stays blocked on the next launch when the facts have not moved', async () => {
    await seedPglite();
    const facts = {
      liveBytes: 'lt_32mib' as const,
      largestBackupBytes: 'lt_1gib' as const,
      configuredProjects: '1_9' as const,
      sourceSessions: '1_9' as const,
    };
    recordMigrationBlocked(tmp, {
      reasonCode: 'backup_dwarfs_live',
      facts,
      factsFingerprint: 'stable-fingerprint',
      blockedAt: new Date().toISOString(),
      assessmentVersion: MIGRATION_ASSESSMENT_VERSION,
    });
    // Pre-flight measures the same install the same way and reaches the same
    // verdict, which is what "the facts have not moved" means.
    const orchestrator: OrchestratorLike & { runCalls: number } = {
      runCalls: 0,
      async preflight() {
        return {
          ok: false,
          reason: 'A database backup on disk is far larger …',
          pgliteDirBytes: 10,
          freeBytes: 100,
          requiredBytes: 20,
          refusal: {
            reasonCode: 'backup_dwarfs_live',
            facts,
            factsFingerprint: 'stable-fingerprint',
            reason: 'A database backup on disk is far larger …',
          },
        };
      },
      async run() {
        orchestrator.runCalls += 1;
        return {} as never;
      },
    };

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome).toMatchObject({ action: 'blocked', reasonCode: 'backup_dwarfs_live' });
    expect(orchestrator.runCalls).toBe(0);
    // Durable and still visible: a block is not consumed by being observed.
    expect(getMigrationBlockedState(tmp)?.reasonCode).toBe('backup_dwarfs_live');
    expect(readBackendState(tmp)?.migrationAttempts).toBeUndefined();
  });

  it('reassesses once the measured facts change', async () => {
    await seedPglite();
    recordMigrationBlocked(tmp, {
      reasonCode: 'insufficient_disk',
      facts: {
        liveBytes: 'lt_32mib',
        largestBackupBytes: 'none',
        configuredProjects: 'zero',
        sourceSessions: '1_9',
        freeDiskBytes: 'none',
      },
      factsFingerprint: 'the-disk-was-full',
      blockedAt: new Date().toISOString(),
      assessmentVersion: MIGRATION_ASSESSMENT_VERSION,
    });
    // Pre-flight now passes, which is the "facts changed" signal.
    const orchestrator = stubOrchestrator('ok');

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome.action).toBe('migrated');
    expect(orchestrator.runCalls).toBe(1);
    expect(getMigrationBlockedState(tmp)).toBeNull();
  });

  it('leaves an above-ceiling install on PGLite instead of migrating it', async () => {
    await seedPglite();
    const orchestrator: OrchestratorLike & { runCalls: number } = {
      runCalls: 0,
      async preflight() {
        // 2 GiB source, well past the 256 MiB first-cohort ceiling.
        return { ok: true, pgliteDirBytes: 2 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, requiredBytes: 4 * 1024 ** 3 };
      },
      async run() {
        orchestrator.runCalls += 1;
        return {} as never;
      },
    };

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome).toMatchObject({
      action: 'skipped',
      reason: 'source-above-ceiling',
      // Offered, not walled: the product may still ask, and consent replaces
      // the cohort ceiling and nothing else.
      decision: {
        decision: 'offer_consent',
        skipReason: 'source_above_ceiling',
        sourceBytesBucket: 'lt_3gib',
      },
    });
    expect(orchestrator.runCalls).toBe(0);
    expect(resolveBackend({ userDataPath: tmp }).backend).toBe('pglite');
    // Not walled: no durable verdict, no burnt attempt, nothing for the user
    // to clear. The install is simply outside the active cohort.
    expect(getMigrationBlockedState(tmp)).toBeNull();
    expect(readBackendState(tmp)?.migrationAttempts).toBeUndefined();
  });

  it('reports one exposure decision per configuration version, and retries one that was not accepted', async () => {
    // The ramp's denominator is distinct installs emitting exactly one
    // decision per version. Two would be an observability failure that stops
    // the ramp; zero would make the install invisible while it is still being
    // exposed to the migration.
    await seedPglite();
    const accepted: Array<{ configVersion: string; skipReason: string }> = [];
    let acceptNext = false;
    const onDecision = vi.fn((d: { configVersion: string; skipReason: string }) => {
      if (!acceptNext) return false;
      accepted.push({ configVersion: d.configVersion, skipReason: d.skipReason });
      return true;
    });

    const launch = () =>
      maybeAutoMigrate({
        userDataPath: tmp,
        resolved: resolveBackend({ userDataPath: tmp }),
        // A ceiling below the stub's reported source size, so every launch
        // takes the same non-destructive branch and the only thing varying
        // across the three is whether the decision was accepted.
        authorize: authorized(5),
        orchestrator: stubOrchestrator('ok'),
        relaunch: vi.fn(),
        onDecision,
        buildChannel: 'alpha',
      });

    // Rejected: nothing is marked, so the next launch must ask again.
    await launch();
    expect(accepted).toHaveLength(0);

    acceptNext = true;
    await launch();
    await launch();

    expect(accepted).toEqual([{ configVersion: 'test-ramp', skipReason: 'source_above_ceiling' }]);
    // Twice, not three times: the rejected launch retried, and the launch
    // after the accepted one was suppressed by the marker before it reached
    // the consumer at all.
    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(readBackendState(tmp)?.rolloutDecisionEmitted?.configVersion).toBe('test-ramp');
  });

  it('boots normally when pre-flight fails, without recording a migration failure', async () => {
    await seedPglite();
    const orchestrator = stubOrchestrator('preflight-fail');

    const outcome = await maybeAutoMigrate({
      userDataPath: tmp,
      resolved: resolveBackend({ userDataPath: tmp }),
      authorize: authorized(),
      orchestrator,
      relaunch: vi.fn(),
    });

    expect(outcome).toMatchObject({ action: 'skipped', reason: 'preflight-failed' });
    expect(orchestrator.runCalls).toBe(0);
    // Pre-flight is an environment problem (disk space), not a broken
    // migration -- it must not burn one of the three attempts.
    expect(readBackendState(tmp)?.migrationAttempts).toBeUndefined();
  });
});
