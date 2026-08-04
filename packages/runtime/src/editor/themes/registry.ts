/**
 * Nimbalyst Theme Registry
 *
 * Manages theme registration and provides APIs for accessing themes.
 * Built-in themes are pre-registered; extensions can add custom themes.
 */

import type {
  Theme,
  ThemeId,
  ExtendedThemeColors,
  ThemeContribution,
  ThemeChangeEvent,
} from './types';
import { isBuiltInTheme } from './types';
import { darkThemeColors, getBaseThemeColors, lightThemeColors } from './palette';

// Theme storage
const themes = new Map<ThemeId, Theme>();

// Listeners for theme list changes (when themes are added/removed)
const listChangeListeners = new Set<(themes: Theme[]) => void>();

// Listeners for active theme changes
const activeThemeListeners = new Set<(event: ThemeChangeEvent) => void>();

// Current active theme
let activeThemeId: ThemeId = 'light';

// Built-in themes (only light and dark - other themes are loaded from files)
const builtInThemes: Theme[] = [
  { id: 'light', name: 'Light', isDark: false, colors: lightThemeColors },
  { id: 'dark', name: 'Dark', isDark: true, colors: darkThemeColors },
];

// Initialize built-in themes
builtInThemes.forEach(theme => themes.set(theme.id, theme));

/**
 * Get a theme by ID.
 */
export function getTheme(id: ThemeId): Theme | undefined {
  return themes.get(id);
}

/**
 * Get all registered themes.
 */
export function getAllThemes(): Theme[] {
  return Array.from(themes.values());
}

/**
 * Get only built-in themes.
 */
export function getBuiltInThemes(): Theme[] {
  return getAllThemes().filter(t => isBuiltInTheme(t.id));
}

/**
 * Get only extension-contributed themes.
 */
export function getExtensionThemes(): Theme[] {
  return getAllThemes().filter(t => t.contributedBy !== undefined);
}

/**
 * Re-exported from `./palette` so callers that already reach for the registry
 * keep working; hosts that want only the colors should import `./palette`
 * directly and skip this module's registry state.
 */
export { getBaseThemeColors } from './palette';

/**
 * Register a new theme.
 * Returns a function to unregister the theme.
 */
export function registerTheme(theme: Theme): () => void {
  themes.set(theme.id, theme);
  notifyListChangeListeners();

  return () => {
    themes.delete(theme.id);
    notifyListChangeListeners();
  };
}

/**
 * Register a theme contribution from an extension.
 * Creates a namespaced theme ID and merges with base theme colors.
 * Intelligently derives missing colors from the extension's base colors.
 * Returns a function to unregister the theme.
 */
export function registerThemeContribution(
  extensionId: string,
  contribution: ThemeContribution
): () => void {
  const fullId = `${extensionId}:${contribution.id}`;
  const baseColors = getBaseThemeColors(contribution.isDark);

  // Derive missing colors from extension's base colors for better theme consistency
  // This ensures tables, code blocks, etc. match the extension's color scheme
  const derivedColors: Partial<ExtendedThemeColors> = {};
  // Cast to allow checking extended keys (extension may provide them even if not in base type)
  const extColors = contribution.colors as Partial<ExtendedThemeColors>;

  // Table colors: derive from extension's background colors if not specified
  if (!extColors['table-header'] && extColors['bg-secondary']) {
    derivedColors['table-header'] = extColors['bg-secondary'];
  }
  if (!extColors['table-cell'] && extColors['bg']) {
    derivedColors['table-cell'] = extColors['bg'];
  }
  if (!extColors['table-stripe'] && extColors['bg-tertiary']) {
    derivedColors['table-stripe'] = extColors['bg-tertiary'];
  }
  if (!extColors['table-border'] && extColors['border']) {
    derivedColors['table-border'] = extColors['border'];
  }

  // Code block colors: derive from extension's background if not specified
  if (!extColors['code-bg'] && extColors['bg-secondary']) {
    derivedColors['code-bg'] = extColors['bg-secondary'];
  }
  if (!extColors['code-text'] && extColors['text']) {
    derivedColors['code-text'] = extColors['text'];
  }
  if (!extColors['code-border'] && extColors['border']) {
    derivedColors['code-border'] = extColors['border'];
  }
  if (!extColors['code-gutter'] && extColors['bg-tertiary']) {
    derivedColors['code-gutter'] = extColors['bg-tertiary'];
  }

  // Toolbar colors: derive from extension's background if not specified
  if (!extColors['toolbar-bg'] && extColors['bg']) {
    derivedColors['toolbar-bg'] = extColors['bg'];
  }
  if (!extColors['toolbar-border'] && extColors['border']) {
    derivedColors['toolbar-border'] = extColors['border'];
  }
  if (!extColors['toolbar-hover'] && extColors['bg-hover']) {
    derivedColors['toolbar-hover'] = extColors['bg-hover'];
  }

  // Scrollbar colors: derive from extension's colors if not specified
  if (!extColors['scrollbar-thumb'] && extColors['text-faint']) {
    derivedColors['scrollbar-thumb'] = extColors['text-faint'];
  }
  if (!extColors['scrollbar-thumb-hover'] && extColors['text-muted']) {
    derivedColors['scrollbar-thumb-hover'] = extColors['text-muted'];
  }

  // Quote colors: derive from extension's text colors if not specified
  if (!extColors['quote-text'] && extColors['text-muted']) {
    derivedColors['quote-text'] = extColors['text-muted'];
  }
  if (!extColors['quote-border'] && extColors['border']) {
    derivedColors['quote-border'] = extColors['border'];
  }

  // Terminal colors: derive from extension's colors if not specified
  if (!extColors['terminal-bg'] && extColors['bg-secondary']) {
    derivedColors['terminal-bg'] = extColors['bg-secondary'];
  }
  if (!extColors['terminal-fg'] && extColors['text']) {
    derivedColors['terminal-fg'] = extColors['text'];
  }
  if (!extColors['terminal-cursor'] && extColors['primary']) {
    derivedColors['terminal-cursor'] = extColors['primary'];
  }
  if (!extColors['terminal-cursor-accent'] && (extColors['terminal-bg'] || extColors['bg-secondary'])) {
    derivedColors['terminal-cursor-accent'] = extColors['terminal-bg'] || extColors['bg-secondary'];
  }
  if (!extColors['terminal-selection'] && extColors['bg-selected']) {
    derivedColors['terminal-selection'] = extColors['bg-selected'];
  }

  // Terminal ANSI colors: derive from status colors if not specified
  if (!extColors['terminal-ansi-red'] && extColors['error']) {
    derivedColors['terminal-ansi-red'] = extColors['error'];
  }
  if (!extColors['terminal-ansi-green'] && extColors['success']) {
    derivedColors['terminal-ansi-green'] = extColors['success'];
  }
  if (!extColors['terminal-ansi-yellow'] && extColors['warning']) {
    derivedColors['terminal-ansi-yellow'] = extColors['warning'];
  }
  if (!extColors['terminal-ansi-blue'] && extColors['info']) {
    derivedColors['terminal-ansi-blue'] = extColors['info'];
  }

  const theme: Theme = {
    id: fullId,
    name: contribution.name,
    isDark: contribution.isDark,
    colors: { ...baseColors, ...derivedColors, ...contribution.colors },
    contributedBy: extensionId,
    monaco: contribution.monaco,
  };

  return registerTheme(theme);
}

/**
 * Get themes that carry a Monaco editor theme definition.
 * Used by the renderer Monaco bridge to register matching themes via
 * `monaco.editor.defineTheme()`.
 */
export function getThemesWithMonacoDefinition(): Theme[] {
  return getAllThemes().filter(t => t.monaco !== undefined);
}

/**
 * Get the currently active theme ID.
 */
export function getActiveThemeId(): ThemeId {
  return activeThemeId;
}

/**
 * Get the currently active theme.
 */
export function getActiveTheme(): Theme {
  return themes.get(activeThemeId) || themes.get('light')!;
}

/**
 * Set the active theme.
 * Notifies all active theme listeners of the change.
 */
export function setActiveTheme(themeId: ThemeId): void {
  const newTheme = themes.get(themeId);
  if (!newTheme) {
    console.error(`Theme not found: ${themeId}`);
    return;
  }

  const previousTheme = themes.get(activeThemeId);
  activeThemeId = themeId;

  const event: ThemeChangeEvent = {
    theme: newTheme,
    previousTheme,
  };

  activeThemeListeners.forEach(listener => {
    try {
      listener(event);
    } catch (error) {
      console.error('Error in theme change listener:', error);
    }
  });
}

/**
 * Subscribe to theme list changes (themes added or removed).
 * Returns a function to unsubscribe.
 */
export function onThemesChanged(listener: (themes: Theme[]) => void): () => void {
  listChangeListeners.add(listener);
  return () => listChangeListeners.delete(listener);
}

/**
 * Subscribe to active theme changes.
 * Returns a function to unsubscribe.
 */
export function onActiveThemeChanged(listener: (event: ThemeChangeEvent) => void): () => void {
  activeThemeListeners.add(listener);
  return () => activeThemeListeners.delete(listener);
}

/**
 * Notify list change listeners.
 */
function notifyListChangeListeners(): void {
  const allThemes = getAllThemes();
  listChangeListeners.forEach(listener => {
    try {
      listener(allThemes);
    } catch (error) {
      console.error('Error in theme list change listener:', error);
    }
  });
}

/**
 * Check if a theme exists.
 */
export function hasTheme(id: ThemeId): boolean {
  return themes.has(id);
}

/**
 * Get the color value for a specific key from the active theme.
 */
export function getThemeColor<K extends keyof ExtendedThemeColors>(
  key: K
): ExtendedThemeColors[K] | undefined {
  const theme = getActiveTheme();
  return theme.colors[key];
}
