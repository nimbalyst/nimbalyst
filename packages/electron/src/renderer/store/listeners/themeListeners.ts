/**
 * Central Theme Listener
 *
 * Subscribes to theme-related IPC events ONCE:
 * - `theme-change`        -> updates `themeIdAtom` and applies the theme to the DOM
 * - `theme:list-changed`  -> bumps `themeListChangedVersionAtom` so any component
 *                            rendering the theme list re-fetches via `theme:list`
 *
 * Components read from the atoms (or call applyThemeToDOM directly) instead of
 * subscribing to the IPC events themselves.
 *
 * Call initThemeListener() once at app startup.
 */

import { store, themeIdAtom, type ThemeId } from '@nimbalyst/runtime/store';
import { applyThemeToDOM } from '../../hooks/useTheme';
import { themeListChangedVersionAtom } from '../atoms/themeList';

let initialized = false;

export function initThemeListener(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribeThemeChange = window.electronAPI?.on?.('theme-change', (newTheme: string) => {
    const resolvedTheme = newTheme as ThemeId;
    store.set(themeIdAtom, resolvedTheme);
    void applyThemeToDOM(resolvedTheme);
  });

  const unsubscribeListChanged = window.electronAPI?.on?.('theme:list-changed', () => {
    store.set(themeListChangedVersionAtom, (v) => v + 1);
  });

  return () => {
    initialized = false;
    if (typeof unsubscribeThemeChange === 'function') {
      unsubscribeThemeChange();
    }
    if (typeof unsubscribeListChanged === 'function') {
      unsubscribeListChanged();
    }
  };
}
