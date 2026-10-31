/**
 * Production wiring for migration rollout authorization.
 *
 * The decision logic lives in `rolloutAuthorization.ts` and is pure. This file
 * picks the configuration source and caches the validated snapshot for
 * Settings and support.
 *
 * ## No remote kill switch
 *
 * Through the 256 MiB band the payload came from PostHog flags
 * (`sqlite-rollout-alpha` / `sqlite-rollout-stable`), evaluated live on the
 * launch that would migrate. Those evaluations were billed, and the band's
 * results did not justify the cost of keeping the switch, so the build now
 * delivers the payload itself (`builtInRolloutConfigSource`): sources up to
 * 1 GiB migrate automatically and larger ones are offered a consented
 * migration. Stopping the rollout now means shipping a build.
 *
 * Installs with analytics turned off used to be kept out of automatic
 * migration because a remote disable could not reach them. With no remote
 * disable for anyone, that distinction is gone and they migrate like every
 * other install.
 */

import * as fs from 'fs';

import { getReleaseChannel, type ReleaseChannel } from '../../utils/store';
import { logger } from '../../utils/logger';
import { readBackendState, updateBackendState } from './BackendSelector';
import {
  builtInRolloutConfigSource,
  resolveRolloutAuthorization,
  ROLLOUT_FLAG_KEYS,
  type RolloutAuthorization,
  type RolloutConfigSource,
  type RolloutSnapshot,
} from './rolloutAuthorization';

export { ROLLOUT_FLAG_KEYS };

/**
 * Playwright-only stand-in for the built-in configuration: a JSON file mapping
 * flag keys to payloads, re-read on every launch. It is how an E2E reaches the
 * automatic boot migration, and the disable path, through a real launch.
 * Requires `PLAYWRIGHT=1` as well as the path, so setting one variable on a
 * normal install does nothing.
 *
 * Under Playwright without a file, nothing is delivered: E2E specs that seed
 * a PGLite install for other reasons must not migrate it behind their back.
 */
export const TEST_ROLLOUT_PAYLOAD_ENV = 'NIMBALYST_TEST_ROLLOUT_PAYLOAD_FILE';

export function selectRolloutConfigSource(
  env: NodeJS.ProcessEnv = process.env,
  buildChannel: ReleaseChannel = getReleaseChannel(),
): RolloutConfigSource {
  if (env.PLAYWRIGHT !== '1') return builtInRolloutConfigSource(buildChannel);
  const file = env[TEST_ROLLOUT_PAYLOAD_ENV];
  return {
    isAvailable: () => true,
    fetchPayload: async (flagKey: string) => {
      if (!file || !fs.existsSync(file)) return null;
      const payloads = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      return payloads[flagKey] ?? null;
    },
  };
}

/** Ask whether this launch may migrate. Awaited by the boot path. */
export async function authorizeRollout(userDataPath: string): Promise<RolloutAuthorization> {
  const buildChannel = getReleaseChannel();
  return resolveRolloutAuthorization({
    source: selectRolloutConfigSource(process.env, buildChannel),
    buildChannel,
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
