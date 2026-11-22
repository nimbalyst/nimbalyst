/**
 * Single entry point for pushing the ambient fleet snapshot to the phone.
 *
 * Sibling of `mobilePushRequest.ts` and deliberately much thinner: that lane is
 * an alert, so it is acknowledged, analytics-reported and rate-limited. This one
 * is ambient. It carries no buzz, nobody is waiting on its result, and the
 * phone's own stale date is what reports a desktop that has stopped sending. The
 * only thing worth logging is a throw, and even that must not propagate -- the
 * caller is a menu bar repaint.
 */

import type { FleetActivitySnapshot } from '@nimbalyst/collab-protocol';

import { getSyncProvider } from '../SyncManager';
import { logger } from '../../utils/logger';

/**
 * Whether there is any point deriving a payload at all.
 *
 * Checked before the derivation rather than inside the send so an unpaired
 * install does not rank sessions on every transition for a frame it will drop.
 */
export function isFleetActivityAvailable(): boolean {
  return typeof getSyncProvider()?.sendFleetActivity === 'function';
}

/**
 * @param shownOnDesktop Whether this Mac is displaying the fleet strip itself.
 *   The server pairs it with its own presence check before deciding to suppress
 *   the phone's card — a desktop that claims to be showing the strip but that
 *   nobody is sitting at must not silence the phone.
 */
export async function sendFleetActivity(
  activity: FleetActivitySnapshot,
  shownOnDesktop = false,
): Promise<void> {
  const syncProvider = getSyncProvider();
  if (!syncProvider?.sendFleetActivity) return;

  try {
    // Keep delivery breadcrumbs available for targeted debugging without
    // logging an ambient snapshot on every fleet transition by default.
    const sent = await syncProvider.sendFleetActivity(activity, shownOnDesktop);
    logger.main.debug(
      `[fleetActivityPush] ${sent ? 'Sent' : 'Dropped (index socket not open)'}: ` +
        `running=${activity.running} approval=${activity.needsApproval} decision=${activity.needsDecision} ` +
        `failed=${activity.failed} stalled=${activity.stalled} unread=${activity.unread}`,
    );
  } catch (err) {
    logger.main.warn('[fleetActivityPush] Failed to send fleet activity:', err);
  }
}
