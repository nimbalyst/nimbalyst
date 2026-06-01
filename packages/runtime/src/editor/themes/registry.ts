/**
 * Nimbalyst Theme Registry
 *
 * Manages theme registration and provides APIs for accessing themes.
 * Built-in themes are pre-registered; extensions can add custom themes.
 */

import type {
  Theme,
  ThemeId,
  ThemeColors,
  ExtendedThemeColors,
  ThemeContribution,
  ThemeChangeEvent,
} from './types';
import { isBuiltInTheme } from './types';

// Theme storage
const themes = new Map<ThemeId, Theme>();

// Listeners for theme list changes (when themes are added/removed)
const listChangeListeners = new Set<(themes: Theme[]) => void>();

// Listeners for active theme changes
const activeThemeListeners = new Set<(event: ThemeChangeEvent) => void>();

// Current active theme
let activeThemeId: ThemeId = 'light';

/**
 * Built-in light theme colors.
 */
const lightThemeColors: ExtendedThemeColors = {
  // Backgrounds
  'bg': '#ffffff',
  'bg-secondary': '#f9fafb',
  'bg-tertiary': '#f3f4f6',
  'bg-hover': 'rgba(0, 0, 0, 0.05)',
  'bg-selected': 'rgba(59, 130, 246, 0.1)',
  'bg-active': 'rgba(59, 130, 246, 0.2)',

  // Text
  'text': '#111827',
  'text-muted': '#6b7280',
  'text-faint': '#9ca3af',
  'text-disabled': '#d1d5db',

  // Borders
  'border': '#e5e7eb',
  'border-focus': '#3b82f6',

  // Primary
  'primary': '#3b82f6',
  'primary-hover': '#2563eb',

  // Links
  'link': 'rgb(33, 111, 219)',
  'link-hover': 'rgb(33, 111, 219)',

  // Status
  'success': '#10b981',
  'warning': '#f59e0b',
  'error': '#ef4444',
  'info': '#3b82f6',
  'purple': '#7c3aed',

  // Code
  'code-bg': 'rgb(240, 242, 245)',
  'code-text': '#111827',
  'code-border': '#ccc',
  'code-gutter': '#eee',

  // Table
  'table-border': '#bbb',
  'table-header': '#f2f3f5',
  'table-cell': '#ffffff',
  'table-stripe': '#f2f5fb',

  // Toolbar
  'toolbar-bg': '#ffffff',
  'toolbar-border': '#e5e7eb',
  'toolbar-hover': '#f3f4f6',
  'toolbar-active': 'rgba(59, 130, 246, 0.2)',

  // Special
  'highlight-bg': 'rgba(255, 212, 0, 0.14)',
  'highlight-border': 'rgba(255, 212, 0, 0.3)',
  'quote-text': 'rgb(101, 103, 107)',
  'quote-border': 'rgb(206, 208, 212)',

  // Scrollbar
  'scrollbar-thumb': '#d1d5db',
  'scrollbar-thumb-hover': '#9ca3af',
  'scrollbar-track': 'transparent',

  // Diff
  'diff-add-bg': '#e6ffed',
  'diff-add-border': '#e6ffed',
  'diff-remove-bg': '#ffebe9',
  'diff-remove-border': '#ffebe9',

  // Syntax highlighting
  'code-comment': 'slategray',
  'code-punctuation': '#999',
  'code-property': '#905',
  'code-selector': '#690',
  'code-operator': '#9a6e3a',
  'code-attr': '#07a',
  'code-variable': '#e90',
  'code-function': '#dd4a68',

  // Terminal
  'terminal-bg': '#ffffff',
  'terminal-fg': '#1f2937',
  'terminal-cursor': '#2563eb',
  'terminal-cursor-accent': '#ffffff',
  'terminal-selection': 'rgba(0, 0, 0, 0.15)',

  // Terminal ANSI standard colors (optimized for light background)
  'terminal-ansi-black': '#1f2937',
  'terminal-ansi-red': '#dc2626',
  'terminal-ansi-green': '#16a34a',
  'terminal-ansi-yellow': '#ca8a04',
  'terminal-ansi-blue': '#2563eb',
  'terminal-ansi-magenta': '#9333ea',
  'terminal-ansi-cyan': '#0891b2',
  'terminal-ansi-white': '#f3f4f6',

  // Terminal ANSI bright colors
  'terminal-ansi-bright-black': '#6b7280',
  'terminal-ansi-bright-red': '#ef4444',
  'terminal-ansi-bright-green': '#22c55e',
  'terminal-ansi-bright-yellow': '#eab308',
  'terminal-ansi-bright-blue': '#3b82f6',
  'terminal-ansi-bright-magenta': '#a855f7',
  'terminal-ansi-bright-cyan': '#06b6d4',
  'terminal-ansi-bright-white': '#ffffff',
};

/**
 * Built-in dark theme colors.
 */
const darkThemeColors: ExtendedThemeColors = {
  // Backgrounds
  'bg': '#2d2d2d',
  'bg-secondary': '#1a1a1a',
  'bg-tertiary': '#3a3a3a',
  'bg-hover': 'rgba(255, 255, 255, 0.05)',
  'bg-selected': 'rgba(96, 165, 250, 0.15)',
  'bg-active': '#4a4a4a',

  // Text
  'text': '#ffffff',
  'text-muted': '#b3b3b3',
  'text-faint': '#808080',
  'text-disabled': '#666666',

  // Borders
  'border': '#4a4a4a',
  'border-focus': '#60a5fa',

  // Primary
  'primary': '#60a5fa',
  'primary-hover': '#3b82f6',

  // Links
  'link': '#60a5fa',
  'link-hover': '#93c5fd',

  // Status
  'success': '#4ade80',
  'warning': '#fbbf24',
  'error': '#ef4444',
  'info': '#60a5fa',
  'purple': '#a78bfa',

  // Code
  'code-bg': '#1e1e1e',
  'code-text': '#d4d4d4',
  'code-border': '#4a4a4a',
  'code-gutter': '#2a2a2a',

  // Table
  'table-border': '#4a4a4a',
  'table-header': '#3a3a3a',
  'table-cell': '#2d2d2d',
  'table-stripe': '#363636',

  // Toolbar
  'toolbar-bg': '#2d2d2d',
  'toolbar-border': '#4a4a4a',
  'toolbar-hover': '#3a3a3a',
  'toolbar-active': 'rgba(96, 165, 250, 0.2)',

  // Special
  'highlight-bg': 'rgba(255, 212, 0, 0.2)',
  'highlight-border': 'rgba(255, 212, 0, 0.4)',
  'quote-text': '#b3b3b3',
  'quote-border': '#4a4a4a',

  // Scrollbar
  'scrollbar-thumb': '#4a4a4a',
  'scrollbar-thumb-hover': '#5a5a5a',
  'scrollbar-track': 'transparent',

  // Diff
  'diff-add-bg': 'rgba(40, 167, 69, 0.15)',
  'diff-add-border': 'rgba(40, 167, 69, 0.4)',
  'diff-remove-bg': 'rgba(220, 53, 69, 0.15)',
  'diff-remove-border': 'rgba(220, 53, 69, 0.4)',

  // Syntax highlighting
  'code-comment': '#6a9955',
  'code-punctuation': '#cccccc',
  'code-property': '#9cdcfe',
  'code-selector': '#d7ba7d',
  'code-operator': '#d4d4d4',
  'code-attr': '#92c5f8',
  'code-variable': '#4fc1ff',
  'code-function': '#dcdcaa',

  // Terminal
  'terminal-bg': '#1a1a1a',
  'terminal-fg': '#e5e5e5',
  'terminal-cursor': '#60a5fa',
  'terminal-cursor-accent': '#1a1a1a',
  'terminal-selection': 'rgba(255, 255, 255, 0.2)',

  // Terminal ANSI standard colors (Tailwind palette)
  'terminal-ansi-black': '#000000',
  'terminal-ansi-red': '#ef4444',
  'terminal-ansi-green': '#22c55e',
  'terminal-ansi-yellow': '#eab308',
  'terminal-ansi-blue': '#3b82f6',
  'terminal-ansi-magenta': '#a855f7',
  'terminal-ansi-cyan': '#06b6d4',
  'terminal-ansi-white': '#ffffff',

  // Terminal ANSI bright colors
  'terminal-ansi-bright-black': '#6b7280',
  'terminal-ansi-bright-red': '#f87171',
  'terminal-ansi-bright-green': '#4ade80',
  'terminal-ansi-bright-yellow': '#facc15',
  'terminal-ansi-bright-blue': '#60a5fa',
  'terminal-ansi-bright-magenta': '#c084fc',
  'terminal-ansi-bright-cyan': '#22d3ee',
  'terminal-ansi-bright-white': '#ffffff',
};

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
 * Get the base theme colors for a given dark mode preference.
 * Used for merging extension theme contributions with base colors.
 */
export function getBaseThemeColors(isDark: boolean): ExtendedThemeColors {
  return isDark ? darkThemeColors : lightThemeColors;
}

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
