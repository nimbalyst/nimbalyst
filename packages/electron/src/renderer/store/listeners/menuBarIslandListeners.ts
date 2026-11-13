/**
 * Centralized IPC listener for the menu bar island.
 *
 * The island is its own renderer (`?mode=menu-bar-island`) with an empty session
 * registry, so its entire dataset arrives from the main process. Per
 * docs/IPC_LISTENERS.md the subscription lives here and `MenuBarIslandApp` reads
 * the atom.
 */

import { atom } from 'jotai';
// Deep path: the renderer store barrel pulls every atom module, and this
// listener is the only store user in the lightweight menu-bar island entry.
import { store } from '@nimbalyst/runtime/store/store';
import { getBaseThemeColors } from '@nimbalyst/runtime/editor/themes/palette';
import type { ExtendedThemeColors } from '@nimbalyst/runtime/editor/themes/types';
import { CSS_VAR_MAP } from '../../utils/themeCssVars';
import { DEFAULT_ISLAND_PANEL_SIZE, MENU_BAR_ISLAND_CHANNELS, type MenuBarIslandState } from '../../../shared/menuBarIsland';
import { emptyTrayPanelFeed } from '../../../shared/traySessions';

export function emptyMenuBarIslandState(): MenuBarIslandState {
  return {
    strip: {
      mode: 'counts',
      needsApproval: 0,
      needsDecision: 0,
      running: 0,
      failed: 0,
      stalled: 0,
      unread: 0,
      age: null,
    },
    feed: emptyTrayPanelFeed(),
    snippets: {},
    expanded: false,
    // Main overrides this with the real display's anchor on the first frame.
    // Centring is the safe placeholder: nothing is painted yet either way.
    anchor: 'center',
    panelSize: DEFAULT_ISLAND_PANEL_SIZE,
    // Only ever on screen for the frame before main's first push. The island is
    // by definition the live style if this renderer is running at all.
    settings: {
      style: 'island',
      showFleetStatus: true,
      osNotifications: true,
      preventSleep: null,
    },
  };
}

/** The last frame pushed by TrayManager. */
export const menuBarIslandStateAtom = atom<MenuBarIslandState>(emptyMenuBarIslandState());

/** The tray glyph, pushed once on load. Empty until it arrives. */
export const menuBarIslandGlyphAtom = atom<string | null>(null);

/**
 * Subscribe to state pushes.
 *
 * Unlike the tray panel there is no initial pull: main creates this window only
 * once it already has a frame to draw, and sends it on `did-finish-load`.
 */
/**
 * Fill in anything the frame did not carry.
 *
 * Main and this renderer reload independently in dev, so a frame written by an
 * older main can arrive against newer renderer code. A whole-state overwrite
 * then leaves a field the components read as `undefined` -- the settings panel
 * threw on exactly that. Defaults are cheap; the next real frame corrects them.
 */
function withDefaults(next: MenuBarIslandState | null | undefined): MenuBarIslandState {
  const fallback = emptyMenuBarIslandState();
  if (!next) return fallback;
  return { ...fallback, ...next, settings: next.settings ?? fallback.settings };
}

const BASE_THEMES = ['light', 'dark', 'crystal-dark'] as const;

/**
 * The island's entry skips the app's theme module (it drags in the runtime
 * barrel), so it applies the theme itself. The base class alone is not enough:
 * NimbalystTheme.css only carries light fallbacks, and the real `--nim-*`
 * colors are inline styles that useTheme writes. Crystal-dark and extension
 * themes get the base dark/light palette here, not their own colors.
 */
function applyIslandBaseTheme(): void {
  const resolved = window.electronAPI.getResolvedThemeSync?.();
  const theme = BASE_THEMES.find((t) => t === resolved) ?? 'light';
  const root = document.documentElement;
  for (const t of BASE_THEMES) root.classList.remove(`${t}-theme`);
  root.classList.add(`${theme}-theme`);
  root.setAttribute('data-theme', theme);

  const colors = getBaseThemeColors(theme !== 'light');
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
    const value = colors[key as keyof ExtendedThemeColors];
    if (value) root.style.setProperty(cssVar, value);
  }
}

export function initMenuBarIslandListener(): () => void {
  applyIslandBaseTheme();
  const unsubscribeTheme = window.electronAPI.on('theme-change', applyIslandBaseTheme);
  const unsubscribe = window.electronAPI.on(
    MENU_BAR_ISLAND_CHANNELS.state,
    (next: MenuBarIslandState) => {
      store.set(menuBarIslandStateAtom, withDefaults(next));
    },
  );
  // Pull the glyph and the current frame now that this listener exists. Main
  // cannot usefully push either at `did-finish-load`: React has not mounted, so
  // there is nothing subscribed to receive them.
  void window.electronAPI
    .invoke(MENU_BAR_ISLAND_CHANNELS.requestInit)
    .then((init: { glyph?: string; state?: MenuBarIslandState | null } | null) => {
      if (!init) return;
      if (init.glyph) store.set(menuBarIslandGlyphAtom, init.glyph);
      if (init.state) store.set(menuBarIslandStateAtom, withDefaults(init.state));
    });

  return () => {
    unsubscribe?.();
    unsubscribeTheme?.();
  };
}
