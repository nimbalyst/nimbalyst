/**
 * Centralized listener for this window's OS focus state (NIM-849).
 *
 * Follows the centralized-listener architecture: components NEVER subscribe to
 * IPC directly; this listener keeps `windowFocusedAtom` in sync from the main
 * process's per-window `browser-window-focus`/`blur` events, and components read
 * the atom.
 *
 * Main's per-window signal is the reliable replacement for `document.hasFocus()`,
 * which is true for every window while the app is active and so let background
 * windows' Claude CLI sessions all spawn on app activation (rate-limit stampede).
 */

import { store } from '../index';
import { windowFocusedAtom } from '../atoms/windowFocus';

export function initWindowFocusListeners(): () => void {
  // Seed the initial state — the foreground window resolves true, background
  // windows false — so the launch gate is correct before any focus event fires.
  window.electronAPI
    .invoke('window:is-focused')
    .then((focused: boolean) => store.set(windowFocusedAtom, !!focused))
    .catch(() => {
      // best-effort seed; the focus-changed subscription below still keeps us live
    });

  const handler = (focused: boolean) => {
    store.set(windowFocusedAtom, !!focused);
  };
  const unsubscribe = window.electronAPI.on('window:focus-changed', handler);

  return () => {
    unsubscribe();
  };
}
