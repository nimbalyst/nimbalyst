/**
 * The single place a recovery domain result becomes an analytics event.
 *
 * The recovery transaction emits `recovery_started` before the first
 * destructive operation, which is requirement 3 of
 * `.claude/rules/destructive-data-paths.md` and the specific gap that hid
 * #1347 for nine months: the old recovery event was only computed if the same
 * process finished initialization, so a process that died mid-recovery
 * reported nothing at all. Emitting first only helps if the emission actually
 * leaves the machine, and until now production mapped every recovery domain
 * event to `logger.main.info` and stopped there.
 *
 * Mirrors `sqlite/migrationEventMapper.ts` deliberately: one mapper per domain,
 * both owned by main, nothing below main naming an event or putting an
 * unbounded string in a property. Recovery is a separate domain with separate
 * event names, so it is a sibling rather than a case in that switch.
 *
 * Every property here is categorical or a bucket. Byte counts, row counts,
 * paths and error text stay in the local log.
 */

import { AnalyticsService } from '../../services/analytics/AnalyticsService';
import { logger } from '../../utils/logger';
import type { RecoveryDomainEvent } from './types';

/**
 * Where the recovery was started from. Not part of the domain event -- the
 * transaction has no business knowing which button was pressed -- so the
 * wiring supplies it.
 */
export type RecoveryTrigger = 'settings' | 'failure-dialog' | 'backup-restore';

export function emitRecoveryEvent(event: RecoveryDomainEvent, trigger: RecoveryTrigger): void {
  logger.main.info('[Recovery] domain event', { ...event, trigger });

  const { name, properties } = buildRecoveryEvent(event);
  try {
    AnalyticsService.getInstance().sendEvent(name, { ...properties, trigger });
  } catch (err) {
    // A recovery must never fail because telemetry did.
    logger.main.warn('[Recovery] outcome event failed to send', err);
  }
}

export function buildRecoveryEvent(event: RecoveryDomainEvent): {
  name: string;
  properties: Record<string, unknown>;
} {
  switch (event.type) {
    case 'recovery_started':
      return {
        name: 'database_recovery_started',
        properties: {
          backend: event.backend,
          candidate_size_bucket: event.candidateSizeBucket,
          live_size_bucket: event.liveSizeBucket,
          reason_code: event.reasonCode ?? 'none',
        },
      };
    case 'recovery_succeeded':
      return {
        name: 'database_recovery_succeeded',
        properties: {
          backend: event.backend,
          candidate_size_bucket: event.candidateSizeBucket,
        },
      };
    case 'recovery_failed':
      return {
        name: 'database_recovery_failed',
        properties: {
          backend: event.backend,
          // Both closed unions; see `types.ts`. No message text travels.
          code: event.code,
          failed_step: event.failedStep ?? 'none',
          rolled_back: event.rolledBack,
        },
      };
  }
}
