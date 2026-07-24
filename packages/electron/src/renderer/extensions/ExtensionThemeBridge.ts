/**
 * Extension Theme Bridge
 *
 * Bridges the runtime theme registry (renderer) with the main process so that
 * `theme:list` can return extension-contributed themes and the main process
 * can detect when the active theme has disappeared (extension disabled or
 * uninstalled) and apply a sensible fallback.
 *
 * The renderer is the source of truth for extension themes -- extensions
 * activate in the renderer and call `registerThemeContribution`. Whenever the
 * runtime registry changes, this bridge pushes the current set of extension
 * themes to main via the `theme:extension-themes-changed` IPC channel.
 */

import {
  getExtensionThemes,
  onThemesChanged,
  getExtensionLoader,
} from '@nimbalyst/runtime';
import { logger } from '../utils/logger';

interface ExtensionThemeEntry {
  id: string;
  name: string;
  isDark: boolean;
  contributedBy: string;
}

let initialized = false;

function buildSnapshot(): ExtensionThemeEntry[] {
  return getExtensionThemes()
    .map(t => ({
      id: t.id,
      name: t.name,
      isDark: t.isDark,
      contributedBy: t.contributedBy ?? '',
    }))
    .filter(t => t.contributedBy !== '');
}

function pushToMain(): void {
  const snapshot = buildSnapshot();
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.send) return;
  try {
    electronAPI.send('theme:extension-themes-changed', snapshot);
  } catch (error) {
    logger.ui.warn('[ExtensionThemeBridge] Failed to push extension themes to main:', error);
  }
}

/**
 * Initialize the bridge. Sends the current snapshot once and subscribes to
 * registry changes to keep main in sync.
 */
export function initializeExtensionThemeBridge(): void {
  if (initialized) return;
  initialized = true;

  // Subscribe to registry list changes (themes added/removed)
  onThemesChanged(() => {
    pushToMain();
  });

  // Also sync when extensions load/unload, in case an extension finishes
  // activating between two registry change events.
  const loader = getExtensionLoader();
  loader.subscribe(() => {
    pushToMain();
  });

  // Initial push (covers the boot path: extensions load before this is called)
  pushToMain();

  logger.ui.info('[ExtensionThemeBridge] Initialized');
}
