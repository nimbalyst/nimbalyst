/**
 * Production wiring for the migration rollout kill switch.
 *
 * The decision logic lives in `rolloutAuthorization.ts` and is pure. This file
 * is the only part that knows about PostHog, the release channel, and the disk.
 *
 * ## What changed, and why the old shape was not a kill switch
 *
 * This module used to cache a boolean in `database-backend.json` the first
 * time PostHog answered, and the boot path read only that cache. An install
 * that had ever seen `true` kept migrating forever; turning the flag off
 * stopped new exposures and nothing else. For an operation that renames the
 * user's only copy of their data, that is not a switch, it is a memory.
 *
 * Now the boot path asks on the launch that would migrate, with a bounded
 * timeout, and no answer means no migration. The snapshot still lands on disk,
 * but only so Settings and support can see what this install was last told --
 * nothing reads it to authorize anything.
 *
 * ## Analytics-opted-out installs
 *
 * `AnalyticsService` refuses to evaluate flags when the user has opted out of
 * analytics, which means a remote disable has no path to those machines. The
 * plan gives two ways out: add a separate configuration fetch that ignores
 * analytics consent, or keep opted-out installs out of automatic migration.
 *
 * **We keep them out.** Automatic migration is not offered to an install we
 * cannot subsequently stop. The alternative -- a second outbound request, on
 * every launch, for the specific users who asked us not to phone home -- buys
 * a faster ramp by spending the one thing those users explicitly withheld, and
 * it needs an endpoint that does not exist yet and that would then have to be
 * kept alive for as long as any old build is in the field. Neither cost is
 * worth paying for a migration that stays available to them, on demand, from
 * Settings.
 *
 * The consequence is stated rather than hidden: opted-out installs report
 * `authorization_unavailable` and stay on PGLite until the user migrates
 * manually. `RolloutConfigSource` is an interface precisely so that adding a
 * consent-independent transport later is a new implementation of
 * `isAvailable`/`fetchPayload` and touches no decision code.
 */

import { AnalyticsService } from '../../services/analytics/AnalyticsService';
import { getReleaseChannel } from '../../utils/store';
import { logger } from '../../utils/logger';
import { readBackendState, updateBackendState } from './BackendSelector';
import {
  resolveRolloutAuthorization,
  ROLLOUT_FLAG_KEYS,
  type RolloutAuthorization,
  type RolloutConfigSource,
  type RolloutSnapshot,
} from './rolloutAuthorization';

export { ROLLOUT_FLAG_KEYS };

/**
 * PostHog as a configuration channel.
 *
 * `isAvailable` is the consent gate described in the file header. It is a
 * separate method from `fetchPayload` on purpose: "we chose not to ask" and
 * "we asked and got nothing" are the same *outcome* but different *facts*, and
 * only the first one is permanent for this install.
 */
export function postHogRolloutConfigSource(): RolloutConfigSource {
  return {
    isAvailable: () => {
      try {
        return AnalyticsService.getInstance().canEvaluateRemoteConfig();
      } catch {
        return false;
      }
    },
    fetchPayload: async (flagKey: string) => {
      try {
        return await AnalyticsService.getInstance().getFeatureFlagPayload(flagKey);
      } catch (err) {
        logger.main.warn('[rollout] payload fetch threw', err);
        return null;
      }
    },
  };
}

/**
 * Ask whether this launch may migrate. Awaited by the boot path, which is
 * already async and already waits on pre-flight; a bounded wait before a
 * multi-minute destructive operation is proportionate, and it only happens on
 * installs that are actually migration-due.
 */
export async function authorizeRollout(userDataPath: string): Promise<RolloutAuthorization> {
  return resolveRolloutAuthorization({
    source: postHogRolloutConfigSource(),
    buildChannel: getReleaseChannel(),
    onSnapshot: (snapshot) => cacheRolloutSnapshot(userDataPath, snapshot),
    log: (level, msg, meta) => logger.main[level](msg, meta),
  });
}

/**
 * Record the last validated snapshot for Settings and support.
 *
 * Diagnostic only. Nothing reads this to decide whether to migrate -- see
 * `resolveRolloutAuthorization`, which takes no cache at all. Best-effort: a
 * read-only userData must not turn a fine launch into a failed one.
 */
export function cacheRolloutSnapshot(userDataPath: string, snapshot: RolloutSnapshot): void {
  try {
    updateBackendState(userDataPath, { rolloutSnapshot: snapshot });
  } catch (err) {
    logger.main.warn('[rollout] could not cache the rollout snapshot', err);
  }
}

/** The last validated snapshot, for display. Never an input to a decision. */
export function readCachedRolloutSnapshot(userDataPath: string): RolloutSnapshot | null {
  return readBackendState(userDataPath)?.rolloutSnapshot ?? null;
}
