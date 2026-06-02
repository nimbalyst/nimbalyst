import { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { ConfigTheme } from '@nimbalyst/runtime';
import { themeIdAtom, setThemeAtom, store, type ThemeId } from '@nimbalyst/runtime/store';
import { getBaseThemeColors, getTheme as getRuntimeTheme, onThemesChanged, type ExtendedThemeColors } from '@nimbalyst/runtime';

/**
 * Map of ExtendedThemeColors keys to CSS variable names.
 *
 * These are the --nim-* variable names that components use directly.
 * Extension themes override these variables to change the look.
 */
const CSS_VAR_MAP: Record<keyof ExtendedThemeColors, string> = {
  // Core colors - set --nim-* vars directly
  'bg': '--nim-bg',
  'bg-secondary': '--nim-bg-secondary',
  'bg-tertiary': '--nim-bg-tertiary',
  'bg-hover': '--nim-bg-hover',
  'bg-selected': '--nim-bg-selected',
  'bg-active': '--nim-bg-active',
  'text': '--nim-text',
  'text-muted': '--nim-text-muted',
  'text-faint': '--nim-text-faint',
  'text-disabled': '--nim-text-disabled',
  'border': '--nim-border',
  'border-focus': '--nim-border-focus',
  'primary': '--nim-primary',
  'primary-hover': '--nim-primary-hover',
  'on-primary': '--nim-on-primary',
  'link': '--nim-link',
  'link-hover': '--nim-link-hover',
  'success': '--nim-success',
  'warning': '--nim-warning',
  'error': '--nim-error',
  'info': '--nim-info',
  'purple': '--nim-purple',

  // Code blocks
  'code-bg': '--nim-code-bg',
  'code-text': '--nim-code-text',
  'code-border': '--nim-code-border',
  'code-gutter': '--nim-code-gutter',

  // Table
  'table-border': '--nim-table-border',
  'table-header': '--nim-table-header',
  'table-cell': '--nim-table-cell',
  'table-stripe': '--nim-table-stripe',

  // Toolbar
  'toolbar-bg': '--nim-toolbar-bg',
  'toolbar-border': '--nim-toolbar-border',
  'toolbar-hover': '--nim-toolbar-hover',
  'toolbar-active': '--nim-toolbar-active',

  // Special
  'highlight-bg': '--nim-highlight-bg',
  'highlight-border': '--nim-highlight-border',
  'quote-text': '--nim-quote-text',
  'quote-border': '--nim-quote-border',

  // Scrollbar
  'scrollbar-thumb': '--nim-scrollbar-thumb',
  'scrollbar-thumb-hover': '--nim-scrollbar-thumb-hover',
  'scrollbar-track': '--nim-scrollbar-track',

  // Diff
  'diff-add-bg': '--nim-diff-add-bg',
  'diff-add-border': '--nim-diff-add-border',
  'diff-remove-bg': '--nim-diff-remove-bg',
  'diff-remove-border': '--nim-diff-remove-border',

  // Syntax highlighting
  'code-comment': '--nim-code-comment',
  'code-punctuation': '--nim-code-punctuation',
  'code-property': '--nim-code-property',
  'code-selector': '--nim-code-selector',
  'code-operator': '--nim-code-operator',
  'code-attr': '--nim-code-attr',
  'code-variable': '--nim-code-variable',
  'code-function': '--nim-code-function',

  // Terminal
  'terminal-bg': '--terminal-bg',
  'terminal-fg': '--terminal-fg',
  'terminal-cursor': '--terminal-cursor',
  'terminal-cursor-accent': '--terminal-cursor-accent',
  'terminal-selection': '--terminal-selection',

  // Terminal ANSI standard colors (0-7)
  'terminal-ansi-black': '--terminal-ansi-black',
  'terminal-ansi-red': '--terminal-ansi-red',
  'terminal-ansi-green': '--terminal-ansi-green',
  'terminal-ansi-yellow': '--terminal-ansi-yellow',
  'terminal-ansi-blue': '--terminal-ansi-blue',
  'terminal-ansi-magenta': '--terminal-ansi-magenta',
  'terminal-ansi-cyan': '--terminal-ansi-cyan',
  'terminal-ansi-white': '--terminal-ansi-white',

  // Terminal ANSI bright colors (8-15)
  'terminal-ansi-bright-black': '--terminal-ansi-bright-black',
  'terminal-ansi-bright-red': '--terminal-ansi-bright-red',
  'terminal-ansi-bright-green': '--terminal-ansi-bright-green',
  'terminal-ansi-bright-yellow': '--terminal-ansi-bright-yellow',
  'terminal-ansi-bright-blue': '--terminal-ansi-bright-blue',
  'terminal-ansi-bright-magenta': '--terminal-ansi-bright-magenta',
  'terminal-ansi-bright-cyan': '--terminal-ansi-bright-cyan',
  'terminal-ansi-bright-white': '--terminal-ansi-bright-white',
};

/**
 * Initialize theme from main process.
 * Called once at app startup to sync the atom with main process state.
 *
 * The IPC subscription for `theme-change` lives in
 * store/listeners/themeListeners.ts (centralized listener pattern).
 */
export function initializeTheme(): void {
  // Get theme synchronously from main process
  const mainProcessTheme = window.electronAPI?.getThemeSync?.() || 'light';
  store.set(themeIdAtom, mainProcessTheme as ThemeId);

  // Apply the theme (handles both built-in and custom themes)
  void applyThemeToDOM(mainProcessTheme as ThemeId);
}

/**
 * Parse a CSS color into [r, g, b] in [0, 255]. Returns null if the format
 * isn't recognized (e.g. hsl(), color-mix(), or a named color we don't know).
 * Only handles the formats themes actually emit: #rgb, #rrggbb, #rrggbbaa,
 * rgb()/rgba().
 */
function parseColorToRgb(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  const hex = trimmed.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      if (![r, g, b].some(Number.isNaN)) return [r, g, b];
    }
    return null;
  }
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];
  return null;
}

/** WCAG relative luminance for an sRGB color. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrastRatio(a: number, b: number): number {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick a readable foreground for a `primary`-style background.
 *
 * Preserves the historical default of white text on the brand color when it
 * meets the WCAG large-text/UI minimum (3.0:1), and only flips to a dark
 * foreground when white is illegible. This stops light/pastel accents (e.g.
 * Rose Pine dawn's #ebbcba) from rendering near-invisible labels while
 * keeping the look of the default blue button unchanged. Returns null if the
 * background color string isn't a format we can parse, in which case the
 * base theme's `on-primary` is used.
 */
function deriveOnPrimary(primary: string): string | null {
  const rgb = parseColorToRgb(primary);
  if (!rgb) return null;
  const l = relativeLuminance(rgb);
  const whiteContrast = contrastRatio(l, 1);
  if (whiteContrast >= 3.0) return '#ffffff';
  return '#111827';
}

/**
 * Derive missing colors from the theme's base colors.
 * This ensures tables, code blocks, etc. match the theme's color scheme
 * even if the theme author didn't explicitly specify these colors.
 */
function deriveColorsFromTheme(
  themeColors: Partial<ExtendedThemeColors>,
  baseColors: ExtendedThemeColors
): ExtendedThemeColors {
  const derived: Partial<ExtendedThemeColors> = {};

  // Primary foreground: when a theme contributes its own `primary` but no
  // `on-primary`, pick the readable foreground from the primary's luminance
  // rather than inheriting the base theme's `on-primary` (which was paired
  // with a totally different background).
  if (!themeColors['on-primary'] && themeColors['primary']) {
    const derivedOnPrimary = deriveOnPrimary(themeColors['primary']);
    if (derivedOnPrimary) derived['on-primary'] = derivedOnPrimary;
  }

  // Table colors: derive from theme's background colors if not specified
  if (!themeColors['table-header'] && themeColors['bg-secondary']) {
    derived['table-header'] = themeColors['bg-secondary'];
  }
  if (!themeColors['table-cell'] && themeColors['bg']) {
    derived['table-cell'] = themeColors['bg'];
  }
  if (!themeColors['table-stripe'] && themeColors['bg-tertiary']) {
    derived['table-stripe'] = themeColors['bg-tertiary'];
  }
  if (!themeColors['table-border'] && themeColors['border']) {
    derived['table-border'] = themeColors['border'];
  }

  // Code block colors: derive from theme's background if not specified
  if (!themeColors['code-bg'] && themeColors['bg-secondary']) {
    derived['code-bg'] = themeColors['bg-secondary'];
  }
  if (!themeColors['code-text'] && themeColors['text']) {
    derived['code-text'] = themeColors['text'];
  }
  if (!themeColors['code-border'] && themeColors['border']) {
    derived['code-border'] = themeColors['border'];
  }
  if (!themeColors['code-gutter'] && themeColors['bg-tertiary']) {
    derived['code-gutter'] = themeColors['bg-tertiary'];
  }

  // Toolbar colors: derive from theme's background if not specified
  if (!themeColors['toolbar-bg'] && themeColors['bg']) {
    derived['toolbar-bg'] = themeColors['bg'];
  }
  if (!themeColors['toolbar-border'] && themeColors['border']) {
    derived['toolbar-border'] = themeColors['border'];
  }
  if (!themeColors['toolbar-hover'] && themeColors['bg-hover']) {
    derived['toolbar-hover'] = themeColors['bg-hover'];
  }

  // Scrollbar colors: derive from theme's colors if not specified
  if (!themeColors['scrollbar-thumb'] && themeColors['text-faint']) {
    derived['scrollbar-thumb'] = themeColors['text-faint'];
  }
  if (!themeColors['scrollbar-thumb-hover'] && themeColors['text-muted']) {
    derived['scrollbar-thumb-hover'] = themeColors['text-muted'];
  }

  // Quote colors: derive from theme's text colors if not specified
  if (!themeColors['quote-text'] && themeColors['text-muted']) {
    derived['quote-text'] = themeColors['text-muted'];
  }
  if (!themeColors['quote-border'] && themeColors['border']) {
    derived['quote-border'] = themeColors['border'];
  }

  // Terminal colors: derive from theme's colors if not specified
  if (!themeColors['terminal-bg'] && themeColors['bg-secondary']) {
    derived['terminal-bg'] = themeColors['bg-secondary'];
  }
  if (!themeColors['terminal-fg'] && themeColors['text']) {
    derived['terminal-fg'] = themeColors['text'];
  }
  if (!themeColors['terminal-cursor'] && themeColors['primary']) {
    derived['terminal-cursor'] = themeColors['primary'];
  }
  if (!themeColors['terminal-cursor-accent'] && (themeColors['terminal-bg'] || themeColors['bg-secondary'])) {
    derived['terminal-cursor-accent'] = themeColors['terminal-bg'] || themeColors['bg-secondary'];
  }
  if (!themeColors['terminal-selection'] && themeColors['bg-selected']) {
    derived['terminal-selection'] = themeColors['bg-selected'];
  }

  // Terminal ANSI colors: derive from status colors if not specified
  if (!themeColors['terminal-ansi-red'] && themeColors['error']) {
    derived['terminal-ansi-red'] = themeColors['error'];
  }
  if (!themeColors['terminal-ansi-green'] && themeColors['success']) {
    derived['terminal-ansi-green'] = themeColors['success'];
  }
  if (!themeColors['terminal-ansi-yellow'] && themeColors['warning']) {
    derived['terminal-ansi-yellow'] = themeColors['warning'];
  }
  if (!themeColors['terminal-ansi-blue'] && themeColors['info']) {
    derived['terminal-ansi-blue'] = themeColors['info'];
  }

  // Merge: base colors < derived colors < explicit theme colors
  return { ...baseColors, ...derived, ...themeColors } as ExtendedThemeColors;
}

/**
 * Apply theme to DOM (classList and data-theme attribute).
 * For custom themes, also applies CSS variables.
 */
export async function applyThemeToDOM(theme: ThemeId): Promise<void> {
  const root = document.documentElement;

  // Resolve 'system' and 'auto' to actual theme based on OS preference
  // These are special values that follow the OS dark/light mode setting
  // Note: The ThemeId type doesn't include these, but they can be stored in preferences
  let resolvedTheme: string = theme;
  const themeStr = theme as string;
  if (themeStr === 'system' || themeStr === 'auto') {
    // Use matchMedia to check OS preference in the renderer
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    resolvedTheme = prefersDark ? 'dark' : 'light';
  }

  // Only 'light' and 'dark' are true built-in themes with hardcoded colors.
  // All other themes (including crystal-dark) are loaded from theme files.
  const isBuiltIn = resolvedTheme === 'light' || resolvedTheme === 'dark';

  if (isBuiltIn) {
    // Built-in themes: use hardcoded color definitions
    const isDark = resolvedTheme === 'dark';
    const colors = getBaseThemeColors(isDark);

    // Set class and data-theme
    const targetClass = isDark ? 'dark-theme' : 'light-theme';
    root.classList.remove('dark-theme', 'light-theme');
    root.classList.add(targetClass);
    root.setAttribute('data-theme', resolvedTheme);

    // Apply colors as inline styles (single source of truth)
    for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
      const colorKey = key as keyof ExtendedThemeColors;
      const value = colors[colorKey];
      if (value) {
        root.style.setProperty(cssVar, value);
      }
    }
  } else {
    // Extension-contributed themes are kept in the in-memory runtime registry,
    // not on disk -- consult the registry before going through the filesystem
    // theme:get IPC.
    const registryTheme = getRuntimeTheme(resolvedTheme);
    if (registryTheme && registryTheme.contributedBy) {
      const isDark = registryTheme.isDark;
      const baseClass = isDark ? 'dark-theme' : 'light-theme';
      root.classList.remove('dark-theme', 'light-theme');
      root.classList.add(baseClass);
      root.setAttribute('data-theme', resolvedTheme);

      const baseColors = getBaseThemeColors(isDark);
      const mergedColors = deriveColorsFromTheme(registryTheme.colors, baseColors);
      for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
        const colorKey = key as keyof ExtendedThemeColors;
        const value = mergedColors[colorKey];
        if (value) {
          root.style.setProperty(cssVar, value);
        }
      }
      console.info(`[useTheme] Applied extension theme: ${registryTheme.name} (${resolvedTheme})`);
      return;
    }

    // File-based theme (crystal-dark, solarized-light, etc.) - fetch and apply colors
    try {
      const themeData = await window.electronAPI.invoke('theme:get', resolvedTheme);
      const isDark = themeData.isDark;

      // Set base class based on isDark (for Tailwind dark mode, icon filters, etc.)
      const baseClass = isDark ? 'dark-theme' : 'light-theme';
      root.classList.remove('dark-theme', 'light-theme');
      root.classList.add(baseClass);
      root.setAttribute('data-theme', resolvedTheme);

      // Get base colors and derive missing colors from theme's base colors
      const baseColors = getBaseThemeColors(isDark);
      const mergedColors = deriveColorsFromTheme(themeData.colors, baseColors);

      // Apply theme colors as CSS variables
      for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
        const colorKey = key as keyof ExtendedThemeColors;
        const value = mergedColors[colorKey];
        if (value) {
          root.style.setProperty(cssVar, value);
        }
      }

      console.info(`[useTheme] Applied theme: ${themeData.name} (${resolvedTheme})`);
    } catch (error) {
      console.error('[useTheme] Failed to load theme:', resolvedTheme, error);
      // Fallback to light theme
      root.classList.remove('dark-theme', 'light-theme');
      root.classList.add('light-theme');
      root.setAttribute('data-theme', 'light');
      // Apply light theme colors
      const colors = getBaseThemeColors(false);
      for (const [key, cssVar] of Object.entries(CSS_VAR_MAP)) {
        const colorKey = key as keyof ExtendedThemeColors;
        const value = colors[colorKey];
        if (value) {
          root.style.setProperty(cssVar, value);
        }
      }
    }
  }
}

/**
 * Clear custom theme CSS variables.
 */
function clearCustomThemeVariables(): void {
  const root = document.documentElement;
  for (const cssVar of Object.values(CSS_VAR_MAP)) {
    root.style.removeProperty(cssVar);
  }
}

/**
 * Get the effective base theme for a theme ID.
 * Handles 'system' and 'auto' by checking OS preference.
 * For extension/file-based themes, we determine dark/light from the theme's
 * `isDark` metadata (the same source the UI uses in applyThemeToDOM), falling
 * back to the theme ID name only when the theme isn't in the registry yet.
 */
function getEffectiveBaseTheme(themeId: string): ConfigTheme {
  // Handle 'system' and 'auto' by checking OS preference
  if (themeId === 'system' || themeId === 'auto') {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    return prefersDark ? 'dark' : 'light';
  }

  // Built-in themes
  if (themeId === 'light') return 'light';
  if (themeId === 'dark') return 'dark';

  // Extension-contributed themes live in the in-memory runtime registry.
  // Resolve dark/light from their actual `isDark` flag instead of guessing
  // from the ID, so themes like `rose-pine` resolve dark in Monaco even
  // though their ID has no `-dark` suffix.
  const registryTheme = getRuntimeTheme(themeId);
  if (registryTheme) {
    return registryTheme.isDark ? 'dark' : 'light';
  }

  // Fallback for file-based themes not in the registry: infer from the ID name.
  // Common dark theme IDs contain 'dark' in their name.
  if (themeId.includes('dark')) {
    return 'dark';
  }

  return 'light';
}

/**
 * Custom hook for managing application theme.
 *
 * IMPORTANT: This hook does NOT re-apply the theme on mount to prevent flash.
 * The initial theme is applied synchronously in index.html before React loads.
 * This hook only:
 * 1. Reads theme from the Jotai atom
 * 2. Provides setTheme for programmatic changes
 *
 * Theme changes from menu are handled by initializeTheme() which runs once.
 *
 * Returns:
 * - theme: The effective base theme ('light' or 'dark') for components that need it
 * - themeId: The raw theme ID (e.g., 'crystal-dark', 'solarized-light')
 * - setTheme: Function to change the theme
 */
export function useTheme() {
  const themeId = useAtomValue(themeIdAtom) as string;
  const setTheme = useSetAtom(setThemeAtom);

  // The runtime theme registry is populated asynchronously as extensions
  // activate. `applyThemeToDOM` and `getEffectiveBaseTheme` both consult it
  // synchronously, so if the persisted theme is extension-contributed and
  // the extension hasn't finished activating yet, the very first apply
  // races and falls back to the file-based `theme:get` IPC -- which the
  // main process refuses with `Theme '<id>' not found. Did you call
  // discoverThemes()?`, and the renderer's catch block paints the light
  // fallback into the DOM. Subscribe to registry changes here so that the
  // moment the extension appears in the registry we re-apply with the
  // correct colors, and the re-render also re-runs `getEffectiveBaseTheme`
  // so Lexical / Monaco / mermaid pick up the correct dark/light base.
  const [registryVersion, setRegistryVersion] = useState(0);
  useEffect(() => {
    return onThemesChanged(() => {
      setRegistryVersion(v => v + 1);
    });
  }, []);

  // `registryVersion` is referenced so React re-renders this hook (and
  // re-runs `getEffectiveBaseTheme` below) whenever the registry list
  // changes -- it intentionally has no other consumer.
  void registryVersion;
  const theme = getEffectiveBaseTheme(themeId) as ConfigTheme;

  // Apply the theme to the DOM when the active theme id changes OR when
  // the registry catches up to it (covers the boot-time race above).
  useEffect(() => {
    void applyThemeToDOM(themeId as ThemeId);
  }, [themeId, registryVersion]);

  return { theme, themeId, setTheme };
}

/**
 * Hook to get just the current theme value.
 * Use this in components that only need to read the theme.
 */
export function useThemeValue(): ConfigTheme {
  return useAtomValue(themeIdAtom) as ConfigTheme;
}

/**
 * Get theme outside of React context.
 * Useful for services and utilities.
 */
export function getTheme(): ThemeId {
  return store.get(themeIdAtom);
}

/**
 * Get all available themes (built-in + user-installed).
 * Fetches from the theme system via IPC.
 */
export async function getAllAvailableThemesAsync(): Promise<Array<{
  id: string;
  name: string;
  isDark: boolean;
}>> {
  try {
    const themeManifests = await window.electronAPI.invoke('theme:list');

    return themeManifests.map((manifest: any) => ({
      id: manifest.id,
      name: manifest.name,
      isDark: manifest.isDark,
    }));
  } catch (error) {
    console.error('[useTheme] Failed to fetch themes:', error);
    // Fallback to built-in themes only
    return [
      { id: 'light', name: 'Light', isDark: false },
      { id: 'dark', name: 'Dark', isDark: true },
    ];
  }
}

