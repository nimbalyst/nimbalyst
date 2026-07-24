/**
 * Theme Atoms
 *
 * Global theme state that all themed components can subscribe to.
 * Platform-specific code (Electron IPC, Capacitor) updates this atom,
 * and all subscribing components re-render.
 *
 * Key principle: Theme is one of the few cases where widespread re-rendering
 * is expected and correct - every themed component needs to repaint.
 * The atom approach gives components control over their own subscriptions,
 * unlike prop drilling where the parent decides what to re-render.
 */

import { atom } from 'jotai';

/**
 * Available theme identifiers.
 * Only 'light' and 'dark' are true built-in themes.
 * Other themes (crystal-dark, solarized-light, etc.) are loaded from files.
 */
export type ThemeId = 'light' | 'dark' | (string & {});

/**
 * Theme color values for use in components.
 */
export interface ThemeColors {
  background: string;
  foreground: string;
  accent: string;
  border: string;
  // Editor-specific
  editorBackground: string;
  editorForeground: string;
  // Syntax highlighting (subset)
  syntaxKeyword: string;
  syntaxString: string;
  syntaxComment: string;
  syntaxVariable: string;
}

/**
 * Full theme object with metadata and colors.
 */
export interface Theme {
  id: ThemeId;
  name: string;
  isDark: boolean;
  colors: ThemeColors;
}

/**
 * Built-in themes (light and dark only).
 * Other themes (crystal-dark, solarized-light, etc.) are loaded from files
 * and use CSS variables for styling.
 */
const themes: Record<string, Theme> = {
  light: {
    id: 'light',
    name: 'Light',
    isDark: false,
    colors: {
      background: '#ffffff',
      foreground: '#1e1e1e',
      accent: '#007acc',
      border: '#e5e5e5',
      editorBackground: '#ffffff',
      editorForeground: '#1e1e1e',
      syntaxKeyword: '#0000ff',
      syntaxString: '#a31515',
      syntaxComment: '#008000',
      syntaxVariable: '#001080',
    },
  },
  dark: {
    id: 'dark',
    name: 'Dark',
    isDark: true,
    colors: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      accent: '#0e639c',
      border: '#3c3c3c',
      editorBackground: '#1e1e1e',
      editorForeground: '#d4d4d4',
      syntaxKeyword: '#569cd6',
      syntaxString: '#ce9178',
      syntaxComment: '#6a9955',
      syntaxVariable: '#9cdcfe',
    },
  },
};

/**
 * Current theme ID atom.
 * Components subscribe to this to react to theme changes.
 */
export const themeIdAtom = atom<ThemeId>('dark');

/**
 * Derived: full theme object.
 * Use this when you need more than just the theme ID.
 * For file-based themes not in the themes map, returns the appropriate
 * base theme (dark for themes with 'dark' in their name, light otherwise).
 */
export const themeAtom = atom((get) => {
  const id = get(themeIdAtom);
  if (themes[id]) {
    return themes[id];
  }
  // For file-based themes, use dark or light base based on theme name
  return id.includes('dark') ? themes['dark'] : themes['light'];
});

/**
 * Derived: is current theme dark?
 * Useful for components that only care about light vs dark.
 * Defaults to true (dark) if theme is not found.
 */
export const isDarkThemeAtom = atom((get) => {
  const theme = get(themeAtom);
  return theme?.isDark ?? true;
});

/**
 * Derived: theme colors only.
 * Use when you just need colors and don't care about other theme metadata.
 * Falls back to dark theme colors if theme is not found.
 */
export const themeColorsAtom = atom((get) => {
  const theme = get(themeAtom);
  return theme?.colors ?? themes['dark'].colors;
});

/**
 * Action: set theme.
 * Called by platform-specific code when theme changes.
 */
export const setThemeAtom = atom(null, (_get, set, themeId: ThemeId) => {
  set(themeIdAtom, themeId);
});

/**
 * Get the theme object by ID.
 * Useful outside of React context.
 */
export function getThemeById(id: ThemeId): Theme {
  return themes[id];
}

/**
 * Register custom theme.
 * Allows extensions to add their own themes.
 */
export function registerCustomTheme(theme: Theme): void {
  themes[theme.id] = theme;
}
