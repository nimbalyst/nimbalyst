/**
 * Central Window Menu Bar Listener
 *
 * Subscribes to `window-menu:changed` ONCE and mirrors the serialized
 * application menu into `windowMenuBarAtom`. Also fetches the initial model,
 * since main only pushes on rebuilds.
 *
 * The in-window menu bar (Windows/Linux) renders from that atom. On macOS main
 * serves an empty model and this listener is effectively inert.
 *
 * Call initWindowMenuListener() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { WINDOW_MENU_CHANNELS, type SerializedMenuBar } from '../../../shared/menuBar';
import { windowMenuBarAtom } from '../atoms/windowMenu';

let initialized = false;

export function initWindowMenuListener(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    WINDOW_MENU_CHANNELS.changed,
    (menuBar: SerializedMenuBar) => {
      if (menuBar && Array.isArray(menuBar.items)) {
        store.set(windowMenuBarAtom, menuBar);
      }
    },
  );

  void window.electronAPI?.getWindowMenuBar?.()
    .then((menuBar) => {
      if (menuBar && Array.isArray(menuBar.items)) {
        store.set(windowMenuBarAtom, menuBar);
      }
    })
    .catch(() => {
      // A window without the menu bridge (e.g. the About window) just renders
      // no strip; nothing to recover from.
    });

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}
