/**
 * Become -- and stay -- an eligible execution host.
 *
 * The server will only route a create-session request to a socket that is BOTH
 * `synced` and announced with an execution-host device type
 * (`IndexRoom.selectExecutionHost` -> `findConnectedHost`, which tests
 * `state.synced && isExecutionHost(device)`). The two halves come from
 * different places and only one of them happens by itself:
 *
 *  - `deviceAnnounce` is automatic. CollabV3Sync sends it in `onopen` and
 *    re-sends it every 30s from `getDeviceInfo`.
 *  - `synced` is NOT. The server sets it when it answers an `indexSyncRequest`
 *    or a bootstrap/delta `indexPageRequest`, and CollabV3Sync issues neither on
 *    connect -- it issues them from `fetchIndex()`, and from hinted drains that
 *    are themselves gated on a mirror a bootstrap has already filled.
 *
 * So a node that only connects and announces looks perfectly healthy from the
 * client side -- open socket, device in the presence list, no errors anywhere --
 * and is silently skipped by every host selection. `fetchIndex()` is what closes
 * that gap, and it has to run again after each reconnect because `synced` is
 * per-socket connection state on the server.
 */

import type { Logger } from './log.js';

export interface IndexEligibilityProvider {
  /** Resolves once the socket is open and past its post-open stability window. */
  waitForIndexReady?(timeoutMs?: number): Promise<void>;
  /** The bootstrap/delta read that makes the server mark this socket `synced`. */
  fetchIndex?(): Promise<{ sessions: unknown[] }>;
}

export interface IndexEligibilityOptions {
  provider: IndexEligibilityProvider;
  log: Logger;
  /** How long to wait for the socket to settle before giving up this attempt. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

/**
 * Run one sync attempt. Returns true when the socket is now `synced`.
 *
 * Never throws: a failed attempt is a log line and a later retry, because the
 * alternative is a node that exits over a transient index read.
 */
export async function ensureIndexSynced(options: IndexEligibilityOptions): Promise<boolean> {
  const { provider, log } = options;

  if (!provider.fetchIndex) {
    log('index-sync-unavailable', { reason: 'provider has no fetchIndex' });
    return false;
  }

  try {
    await provider.waitForIndexReady?.(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    const index = await provider.fetchIndex();
    log('index-synced', { sessions: index.sessions.length });
    return true;
  } catch (error) {
    log('index-sync-failed', {
      error: error instanceof Error ? error.message : String(error),
      consequence: 'this node is not yet eligible to host sessions',
    });
    return false;
  }
}
