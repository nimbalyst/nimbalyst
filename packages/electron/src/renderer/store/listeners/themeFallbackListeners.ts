/**
 * Theme Fallback Listener
 *
 * Subscribes to `theme:fallback-applied` IPC events from main, plus pulls the
 * initial value from the main store, and writes them into
 * `pendingThemeFallbackAtom`. The Themes panel reads this atom to render its
 * inline banner.
 */

import { getDefaultStore } from 'jotai';
import {
  pendingThemeFallbackAtom,
  type PendingThemeFallback,
} from '../atoms/themeFallback';

let initialized = false;

export function initThemeFallbackListener(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const store = getDefaultStore();
  const electronAPI = (window as any).electronAPI;

  // Pull initial pending fallback (set during reconcile that may have run
  // before the renderer subscribed to the IPC).
  if (electronAPI?.invoke) {
    electronAPI
      .invoke('theme:get-pending-fallback')
      .then((value: PendingThemeFallback | null | undefined) => {
        if (value && value.missingId && value.appliedId) {
          store.set(pendingThemeFallbackAtom, value);
        }
      })
      .catch(() => {
        // Best-effort initial read; ignore failures.
      });
  }

  const unsubscribeApplied = electronAPI?.on?.(
    'theme:fallback-applied',
    (data: PendingThemeFallback) => {
      if (data && data.missingId && data.appliedId) {
        store.set(pendingThemeFallbackAtom, data);
      }
    }
  );

  // When the user applies a theme, main clears the pending fallback. The
  // renderer also gets a normal `theme-change` event in that case -- piggyback
  // on it to clear the atom locally.
  const unsubscribeThemeChange = electronAPI?.on?.('theme-change', () => {
    // Re-read pending fallback so we stay in sync (it may still be set if the
    // theme-change came from a reconcile rather than a user action).
    if (electronAPI?.invoke) {
      electronAPI
        .invoke('theme:get-pending-fallback')
        .then((value: PendingThemeFallback | null | undefined) => {
          store.set(pendingThemeFallbackAtom, value ?? null);
        })
        .catch(() => {
          /* ignore */
        });
    }
  });

  return () => {
    initialized = false;
    if (typeof unsubscribeApplied === 'function') unsubscribeApplied();
    if (typeof unsubscribeThemeChange === 'function') unsubscribeThemeChange();
  };
}
