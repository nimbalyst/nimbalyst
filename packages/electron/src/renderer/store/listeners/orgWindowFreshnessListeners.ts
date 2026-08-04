import type { Store } from 'jotai/vanilla/store';

import { store } from '@nimbalyst/runtime/store';
import { windowFocusedAtom } from '../atoms/windowFocus';
import { refreshConversationDirectory } from './conversationDirectoryListeners';
import { refreshOrgSettings } from './orgSettingsListeners';

export interface OrgWindowFreshnessOptions {
  getOrgId: () => string | null;
  targetStore?: Store;
  refreshDirectory?: (orgId: string, targetStore: Store) => Promise<void>;
  refreshSettings?: (orgId: string, targetStore: Store) => Promise<void>;
  /** Overridable for tests; see MIN_REFRESH_INTERVAL_MS. */
  now?: () => number;
  minIntervalMs?: number;
}

/**
 * Bringing the window forward fires both the focus transition and
 * `visibilitychange`, and alt-tabbing through it fires them repeatedly. One
 * read per activation is as fresh as this window needs to be, so signals
 * arriving inside this window are dropped rather than queued.
 */
const MIN_REFRESH_INTERVAL_MS = 10_000;

/**
 * Keep the standalone organization window reasonably fresh without giving it
 * its own team-sync socket. Initial open, OS focus gain, and document
 * visibility all re-read settings and the conversation directory.
 *
 * These re-reads are invisible by design: both refreshes revalidate in place,
 * leaving loaded state and its object identities alone unless the server
 * actually said something new.
 */
export function initOrgWindowFreshnessListeners({
  getOrgId,
  targetStore = store,
  refreshDirectory = refreshConversationDirectory,
  refreshSettings = refreshOrgSettings,
  now = Date.now,
  minIntervalMs = MIN_REFRESH_INTERVAL_MS,
}: OrgWindowFreshnessOptions): () => void {
  let previousFocused = targetStore.get(windowFocusedAtom);
  let inFlight: Promise<void> | null = null;
  let refreshPending = false;
  let lastRefreshAt: number | null = null;

  const refresh = (force = false) => {
    const orgId = getOrgId();
    if (!orgId) return;
    const startedAt = now();
    if (
      !force
      && lastRefreshAt !== null
      && startedAt - lastRefreshAt < minIntervalMs
    ) {
      return;
    }
    lastRefreshAt = startedAt;
    if (inFlight) {
      refreshPending = true;
      return;
    }
    inFlight = Promise.allSettled([
      refreshDirectory(orgId, targetStore),
      refreshSettings(orgId, targetStore),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(
            `[OrgWindow] Failed to refresh ${orgId}:`,
            result.reason,
          );
        }
      }
    }).finally(() => {
      inFlight = null;
      if (refreshPending) {
        refreshPending = false;
        refresh(true);
      }
    });
  };

  const unsubscribeFocus = targetStore.sub(windowFocusedAtom, () => {
    const focused = targetStore.get(windowFocusedAtom);
    if (focused && !previousFocused) refresh();
    previousFocused = focused;
  });
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  refresh(true);

  return () => {
    unsubscribeFocus();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
