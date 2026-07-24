/**
 * Network Availability Listeners (Renderer)
 *
 * Bridges renderer-side network signals to the main-process NetworkAvailability
 * broker, and reacts to the cascade reconnect event by triggering immediate
 * reconnects on providers that live in the renderer (TeamSync, DocumentSync).
 *
 * Flow:
 *   1. `window.online` fires          -> forward to main via IPC
 *      (covers SSID changes that powerMonitor doesn't see)
 *   2. main broker fires `networkAvailable`
 *      -> SyncManager probes CollabV3 index, waits for ready
 *      -> broadcasts `sync:network-available` to renderers
 *   3. This listener catches that broadcast
 *      -> calls reconnectNow() on any active TeamSync/DocumentSync providers
 *
 * Follows IPC_LISTENERS.md: one centralized subscription at startup.
 * Call initNetworkAvailabilityListeners() once in App.tsx on mount.
 */

import { getTeamSyncProvider } from '../atoms/collabDocuments';
import { documentSyncRegistry } from '../atoms/documentSyncRegistry';

let initialized = false;
let cleanupCurrent: (() => void) | null = null;

export function initNetworkAvailabilityListeners(): () => void {
  if (initialized) return cleanupCurrent ?? (() => {});
  initialized = true;

  // 1. Forward `online` events to main so the broker can debounce with its
  //    other sources (powerMonitor.resume/unlock, net.isOnline polling).
  const handleOnline = () => {
    window.electronAPI.send('sync:network-came-online');
  };
  window.addEventListener('online', handleOnline);

  // 2. When main has verified the index is healthy, reconnect renderer-side
  //    providers. Fire-and-forget: each provider handles its own errors.
  const unsubscribeNetworkAvailable = window.electronAPI.on('sync:network-available', () => {
    const teamSync = getTeamSyncProvider();
    if (teamSync) {
      try {
        teamSync.reconnectNow();
      } catch (err) {
        console.error('[NetworkAvailability] TeamSync reconnectNow failed:', err);
      }
    }

    documentSyncRegistry.reconnectAll();
  });

  cleanupCurrent = () => {
    initialized = false;
    window.removeEventListener('online', handleOnline);
    if (typeof unsubscribeNetworkAvailable === 'function') {
      unsubscribeNetworkAvailable();
    }
    cleanupCurrent = null;
  };

  return cleanupCurrent;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cleanupCurrent?.();
  });
}
