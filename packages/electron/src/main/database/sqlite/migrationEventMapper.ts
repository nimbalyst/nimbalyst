/**
 * The single place a migration domain result becomes an analytics event.
 *
 * `SQLiteDatabaseProxy` routes every `db:migration:outcome` the worker emits
 * here; nothing else emits migration lifecycle analytics. That replaces four
 * overlapping emitters (`MigrationOrchestrator`, `MigrationAdopter`,
 * `bootMigration`, `MigrationHandlers`) which between them could describe one
 * cutover under three event names with three different property sets.
 *
 * Two rules the shape enforces rather than documents:
 *   - At most one terminal event per `operationId`. A migration that reports
 *     completion and is then re-reported -- by a retry, a second listener, or
 *     a caller that has not been told the proxy already handled it -- emits
 *     once.
 *   - Only bucketed facts leave. Exact byte counts and row-level detail stay
 *     in the local log, where they are useful and where they cannot become a
 *     high-cardinality property.
 */

import { AnalyticsService } from '../../services/analytics/AnalyticsService';
import { logger } from '../../utils/logger';
import type { DryRunResult } from './MigrationDryRunner';
import { countBucket, sizeBucket, type MigrationOutcome } from './migrationOutcome';

/**
 * Operation ids already reported. An install performs a handful of migration
 * operations in its lifetime and the process restarts after a successful
 * cutover, so this never needs eviction; the cap only exists so a pathological
 * caller cannot grow it without bound.
 */
const emitted = new Set<string>();
const MAX_TRACKED_OPERATIONS = 256;

/** Test seam. Production never clears this — the process restarts instead. */
export function resetMigrationEventDedupeForTests(): void {
  emitted.clear();
}

export function buildMigrationDryRunCompletedProperties(
  result: DryRunResult,
): Record<string, unknown> {
  return {
    target_rows_bucket: countBucket(result.summary.totalRowsCopied),
    duration_ms: Math.round(result.summary.durationMs),
    tables_migrated: result.summary.tablesCopied.length,
    sqlite_file_bytes_bucket: sizeBucket(result.sqliteFileBytes),
    pglite_dir_bytes_bucket: sizeBucket(result.pgliteDirBytes),
    foreign_key_violations: result.summary.foreignKeyViolations,
    integrity_check: result.summary.integrityCheck,
  };
}

export function emitMigrationOutcome(outcome: MigrationOutcome): void {
  if (emitted.has(outcome.operationId)) {
    logger.main.info('[Migration] suppressed duplicate terminal outcome', {
      operationId: outcome.operationId,
      kind: outcome.kind,
    });
    return;
  }
  if (emitted.size >= MAX_TRACKED_OPERATIONS) emitted.clear();
  emitted.add(outcome.operationId);

  const { name, properties } = buildEvent(outcome);
  try {
    AnalyticsService.getInstance().sendEvent(name, properties);
  } catch (err) {
    logger.main.warn('[Migration] outcome event failed to send', err);
  }
}

function buildEvent(outcome: MigrationOutcome): {
  name: string;
  properties: Record<string, unknown>;
} {
  const shared: Record<string, unknown> = {
    operation: outcome.operation,
    trigger: outcome.trigger,
  };
  if (outcome.attempt !== undefined) shared.attempt = outcome.attempt;
  if (outcome.gaveUp !== undefined) shared.gave_up = outcome.gaveUp;

  switch (outcome.kind) {
    case 'completed':
      return {
        name: 'migration_completed',
        properties: {
          ...shared,
          source_bytes_bucket: sizeBucket(outcome.sourceBytes),
          // Bucketed, not exact: a row count is a measure of how much data this
          // user has, and the rule is that exact counts stay in local logs.
          // `tables_migrated` below is bounded by the schema, not by the user.
          target_rows_bucket: countBucket(outcome.rowCount),
          tables_migrated: outcome.tableCount,
          duration_ms: Math.round(outcome.durationMs),
          spot_check_count: outcome.spotCheckCount,
          foreign_key_violations: outcome.foreignKeyViolations,
          integrity_check: outcome.integrityCheck,
        },
      };
    case 'refused':
      return {
        name: 'migration_refused',
        properties: {
          ...shared,
          reason_code: outcome.refusal.reasonCode,
          live_bytes_bucket: outcome.refusal.facts.liveBytes,
          largest_backup_bytes_bucket: outcome.refusal.facts.largestBackupBytes,
          configured_projects_bucket: outcome.refusal.facts.configuredProjects,
          source_sessions_bucket: outcome.refusal.facts.sourceSessions,
          ...(outcome.refusal.facts.freeDiskBytes
            ? { free_disk_bytes_bucket: outcome.refusal.facts.freeDiskBytes }
            : {}),
        },
      };
    case 'failed':
      return {
        name: 'migration_failed',
        properties: {
          ...shared,
          ...(outcome.phase ? { phase: outcome.phase } : {}),
          errorCategory: outcome.errorCategory ?? 'unknown',
          errorCode: outcome.errorCode ?? 'unknown',
          sqlState: outcome.sqlState ?? 'none',
        },
      };
  }
}
