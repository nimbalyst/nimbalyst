// @vitest-environment node
/**
 * One operation, one terminal analytics event.
 *
 * Before this mapper existed the same migration could be reported three times:
 * `MigrationOrchestrator` emitted `migration_completed` from inside the worker,
 * `bootMigration` emitted it again on main, and `MigrationHandlers` emitted it
 * a third time for the Settings path. Only the worker's copy was unwired, so
 * wiring it -- which this workstream does -- would have turned a latent
 * duplicate into a real one. The mapper is the single emitter now, so the
 * dedupe contract is the thing worth a test.
 *
 * It is also the boundary that keeps exact byte counts out of analytics, so
 * the bucketing is checked here rather than at the call sites.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendEvent = vi.fn();
vi.mock('../../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent }) },
}));

import {
  buildMigrationDryRunCompletedProperties,
  emitMigrationOutcome,
  resetMigrationEventDedupeForTests,
} from '../migrationEventMapper';
import type { MigrationOutcome } from '../migrationOutcome';

const completed: MigrationOutcome = {
  kind: 'completed',
  operationId: 'op-1',
  operation: 'migrate',
  trigger: 'auto',
  rowCount: 4211,
  tableCount: 18,
  durationMs: 91_222,
  spotCheckCount: 40,
  foreignKeyViolations: 0,
  integrityCheck: 'ok',
  sourceBytes: 812 * 1024 * 1024,
};

const refused: MigrationOutcome = {
  kind: 'refused',
  operationId: 'op-2',
  operation: 'adopt',
  trigger: 'manual',
  refusal: {
    reasonCode: 'backup_dwarfs_live',
    facts: {
      liveBytes: 'lt_32mib',
      largestBackupBytes: 'lt_1gib',
      configuredProjects: '1_9',
      sourceSessions: '1_9',
    },
    factsFingerprint: 'ff00ff00ff00ff00',
    reason: 'A database backup on disk (612.0 MB) is far larger than …',
  },
};

const failed: MigrationOutcome = {
  kind: 'failed',
  operationId: 'op-3',
  operation: 'migrate',
  trigger: 'auto',
  attempt: 3,
  gaveUp: true,
  phase: 'catching-up-after-close',
  errorCategory: 'unknown',
  errorCode: 'unknown',
  sqlState: 'none',
};

beforeEach(() => {
  sendEvent.mockClear();
  resetMigrationEventDedupeForTests();
});

describe('emitMigrationOutcome', () => {
  it('emits one terminal event per operation id, however many times it is told', () => {
    emitMigrationOutcome(completed);
    emitMigrationOutcome(completed);
    emitMigrationOutcome({ ...completed, kind: 'failed', phase: 'cutover' } as MigrationOutcome);

    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent.mock.calls[0][0]).toBe('migration_completed');
  });

  it('reports size as a bucket, never the measured byte count', () => {
    emitMigrationOutcome(completed);

    const props = sendEvent.mock.calls[0][1];
    expect(props.source_bytes_bucket).toBe('lt_1gib');
    expect(Object.values(props)).not.toContain(completed.sourceBytes);
  });

  it('emits a refusal with its reason code and bounded facts only', () => {
    emitMigrationOutcome(refused);

    expect(sendEvent).toHaveBeenCalledTimes(1);
    const [name, props] = sendEvent.mock.calls[0];
    expect(name).toBe('migration_refused');
    expect(props).toMatchObject({
      operation: 'adopt',
      trigger: 'manual',
      reason_code: 'backup_dwarfs_live',
      live_bytes_bucket: 'lt_32mib',
      largest_backup_bytes_bucket: 'lt_1gib',
    });
    // The human-readable sentence carries exact sizes; it stays local.
    expect(JSON.stringify(props)).not.toMatch(/612/);
  });

  it('carries the auto back-off bookkeeping on a failure', () => {
    emitMigrationOutcome(failed);

    expect(sendEvent.mock.calls[0]).toEqual([
      'migration_failed',
      expect.objectContaining({ attempt: 3, gave_up: true, phase: 'catching-up-after-close' }),
    ]);
  });

  it('never emits unbounded numeric properties for migration outcomes', () => {
    emitMigrationOutcome(completed);
    emitMigrationOutcome(refused);
    emitMigrationOutcome(failed);

    const events = [
      ...sendEvent.mock.calls.map(([name, properties]) => [name, properties] as const),
      [
        'migration_dry_run_completed',
        buildMigrationDryRunCompletedProperties({
          summary: {
            totalRowsCopied: 4211,
            tablesCopied: [{ name: 'ai_sessions', rows: 4211 }],
            durationMs: 91_222,
            spotCheckCount: 5,
            foreignKeyViolations: 0,
            integrityCheck: 'ok',
          },
          dryRunDir: '/local-only/dry-run',
          sqliteFileBytes: 96 * 1024 * 1024,
          pgliteDirBytes: 812 * 1024 * 1024,
        }),
      ] as const,
    ];

    const allowedNumericProperties: Record<string, ReadonlySet<string>> = {
      migration_completed: new Set([
        // Deliberately exact: Phase B.3/C need measured duration distributions.
        'duration_ms',
        // Schema-bounded: allowlisted tables and at most five spot checks each.
        'tables_migrated',
        'spot_check_count',
        // A completed migration can only report zero; any violation throws first.
        'foreign_key_violations',
        // Auto-migration attempts are bounded to 1-3.
        'attempt',
      ]),
      migration_refused: new Set(),
      migration_failed: new Set(['attempt']),
      migration_dry_run_completed: new Set([
        // Deliberately exact for the same scale-analysis requirement above.
        'duration_ms',
        'tables_migrated',
        'foreign_key_violations',
      ]),
    };

    const unboundedNumericProperties = events.flatMap(([eventName, properties]) =>
      Object.entries(properties)
        .filter(([property, value]) => (
          typeof value === 'number'
          && !allowedNumericProperties[eventName]?.has(property)
        ))
        .map(([property, value]) => ({ eventName, property, value })),
    );

    expect(unboundedNumericProperties).toEqual([]);
  });
});
