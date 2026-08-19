/**
 * Single entry point for asking the sync server to push a notification to the
 * user's phone.
 *
 * Every push used to be fire-and-forget: `requestMobilePush` resolved as soon
 * as the WebSocket send did not throw, so a suppressed push, a dropped push and
 * a delivered push were indistinguishable (GitHub #1268). The server now
 * acknowledges, and this is where that acknowledgement becomes a number we can
 * look at -- suppression rates are otherwise only ever inferred.
 *
 * `force` marks an explicit attention alert and bypasses the server's presence
 * suppression. Never gate a forced call site on local presence: the whole point
 * is that the server owns that decision, and a local gate stops `force` ever
 * reaching it.
 */

import type { MobilePushOptions, MobilePushResult } from '@nimbalyst/runtime/sync/types';

import { getSyncProvider } from '../SyncManager';
import { AnalyticsService } from '../analytics/AnalyticsService';
import { logger } from '../../utils/logger';

/**
 * Request a mobile push and report the outcome.
 *
 * Returns null when sync is not available at all; otherwise the server's
 * acknowledgement, or a `no_ack` result if none arrived. Callers may ignore
 * the return value -- reporting happens here.
 */
export async function requestMobilePush(
  sessionId: string,
  title: string,
  body: string,
  options: MobilePushOptions = {},
): Promise<MobilePushResult | null> {
  const syncProvider = getSyncProvider();
  if (!syncProvider?.requestMobilePush) return null;

  try {
    const result = await syncProvider.requestMobilePush(sessionId, title, body, options);

    AnalyticsService.getInstance().sendEvent('mobile_push_requested', {
      reason: options.reason ?? 'unspecified',
      forced: options.force === true,
      accepted: result.accepted,
      attemptedCount: result.attemptedCount,
      deliveredCount: result.deliveredCount,
      rejection: result.rejection ?? null,
    });

    return result;
  } catch (err) {
    logger.main.warn(`[mobilePushRequest] Push request failed for session ${sessionId}:`, err);
    return null;
  }
}
