/**
 * NetworkAvailability - Single broker for "network came back" signals.
 *
 * Before this broker, each sync provider had its own exponential-backoff
 * reconnect loop and none of them listened to OS-level network events. Switch
 * wifi SSIDs without sleeping/locking and you'd wait out whatever backoff
 * timer happened to be running -- up to 60s for TrackerSync, 30s for others.
 *
 * This broker unifies the sources of "network is available" into one debounced
 * event. Consumers subscribe with `onNetworkAvailable(cb)` or call
 * `notifyNetworkAvailable()` directly when they have their own signal (e.g. the
 * renderer forwarding a `window.online` event).
 *
 * Sources currently wired:
 * - `powerMonitor.on('resume')` -- laptop wake from sleep
 * - `powerMonitor.on('unlock-screen')` -- user returns after lock
 * - `net.online` edge transitions polled every 5s (catches SSID changes)
 * - Renderer-forwarded `window.online` events via IPC (see WindowHandlers.ts)
 *
 * The broker itself does not reconnect anything; it just fires an event. The
 * consumer (SyncManager.attemptReconnect) is responsible for probing the index
 * and cascading reconnects to other providers.
 */

import { powerMonitor, net } from 'electron';
import { logger } from '../utils/logger';

type NetworkAvailableListener = () => void;

const listeners = new Set<NetworkAvailableListener>();

/** Last time we fired `networkAvailable`. Used for debounce. */
let lastFiredAt = 0;

/** Debounce window: collapse events that fire within this window of each other. */
const DEBOUNCE_MS = 2000;

/**
 * Delay after `resume` before firing. The OS needs a moment to finish DHCP/DNS
 * on the new interface; firing immediately would burn the first reconnect
 * attempt on a dead socket and push us into backoff. We've observed the WS
 * `open` then error within 7ms when this delay was 2s -- bumping to 5s to
 * catch hotel-wifi-style network handoffs.
 */
const RESUME_SETTLE_MS = 5000;

/**
 * Polling interval for `net.online` edge detection. Cheap check, catches
 * network changes that don't produce a powerMonitor event (e.g. switching
 * wifi SSIDs without sleeping).
 */
const ONLINE_POLL_MS = 5000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastOnlineState: boolean | null = null;
let started = false;

/**
 * Fire the `networkAvailable` event. Debounced by DEBOUNCE_MS so multiple
 * sources (power resume + online poll + renderer IPC) don't fan out three
 * simultaneous reconnect cascades.
 */
export function notifyNetworkAvailable(source: string): void {
  const now = Date.now();
  if (now - lastFiredAt < DEBOUNCE_MS) {
    logger.main.debug(`[NetworkAvailability] Debounced '${source}' (fired ${now - lastFiredAt}ms ago)`);
    return;
  }
  lastFiredAt = now;

  logger.main.info(`[NetworkAvailability] Network available (source: ${source}), notifying ${listeners.size} listener(s)`);
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      logger.main.error('[NetworkAvailability] Listener threw:', err);
    }
  }
}

/**
 * Subscribe to network-available events. Returns an unsubscribe function.
 */
export function onNetworkAvailable(cb: NetworkAvailableListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Start the broker. Idempotent -- safe to call from multiple init paths.
 * Must be called from the main process.
 */
export function startNetworkAvailability(): void {
  if (started) return;
  started = true;

  powerMonitor.on('resume', () => {
    logger.main.info('[NetworkAvailability] powerMonitor resume; settling for', RESUME_SETTLE_MS, 'ms');
    // Defer to give the OS time to reassociate with a network.
    setTimeout(() => notifyNetworkAvailable('powerMonitor:resume'), RESUME_SETTLE_MS);
  });

  powerMonitor.on('unlock-screen', () => {
    // No settle delay -- unlock implies the machine was awake; networks are
    // already up. The 2s debounce handles back-to-back resume+unlock.
    notifyNetworkAvailable('powerMonitor:unlock-screen');
  });

  // Seed initial online state so the first poll doesn't fire on a false edge.
  try {
    lastOnlineState = net.isOnline();
  } catch {
    lastOnlineState = null;
  }

  pollTimer = setInterval(() => {
    let nowOnline: boolean;
    try {
      nowOnline = net.isOnline();
    } catch {
      return;
    }
    if (lastOnlineState === false && nowOnline === true) {
      notifyNetworkAvailable('net.isOnline:edge');
    }
    lastOnlineState = nowOnline;
  }, ONLINE_POLL_MS);

  logger.main.info('[NetworkAvailability] Started (resume + unlock + online poll)');
}

/**
 * Stop the broker. Used for test cleanup and orderly shutdown.
 */
export function stopNetworkAvailability(): void {
  if (!started) return;
  started = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  listeners.clear();
  lastOnlineState = null;
  lastFiredAt = 0;
}
