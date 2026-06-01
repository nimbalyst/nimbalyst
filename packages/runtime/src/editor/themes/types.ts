/**
 * Nimbalyst Theme Type Definitions
 *
 * These types define the structure of themes in Nimbalyst.
 * Extensions can use these types to contribute custom themes.
 */

import type { MonacoThemeContribution } from '@nimbalyst/extension-sdk';

export type { MonacoThemeContribution, MonacoTokenRule } from '@nimbalyst/extension-sdk';

/**
 * Built-in theme identifiers.
 * Only 'light' and 'dark' are true built-in themes with hardcoded colors.
 * Other themes (crystal-dark, solarized-light, etc.) are loaded from files.
 */
export type BuiltInThemeId = 'light' | 'dark';

/**
 * Theme identifier.
 * Built-in themes plus any custom theme IDs registered by extensions.
 * Extension themes use the format: `extensionId:themeId`
 */
export type ThemeId = BuiltInThemeId | (string & {});

/**
 * Complete set of theme color tokens.
 * Uses conventional naming that matches CSS/Tailwind mental models.
 *
 * These map directly to CSS variables:
 * - 'bg' -> --nim-bg
 * - 'bg-secondary' -> --nim-bg-secondary
 * - 'text' -> --nim-text
 * - etc.
 */
export interface ThemeColors {
  // Backgrounds
  'bg': string;
  'bg-secondary': string;
  'bg-tertiary': string;
  'bg-hover': string;
  'bg-selected': string;
  'bg-active': string;

  // Text
  'text': string;
  'text-muted': string;
  'text-faint': string;
  'text-disabled': string;

  // Borders
  'border': string;
  'border-focus': string;

  // Primary (action/brand color)
  'primary': string;
  'primary-hover': string;

  // Links
  'link': string;
  'link-hover': string;

  // Status
  'success': string;
  'warning': string;
  'error': string;
  'info': string;
  'purple': string;
}

/**
 * Extended theme colors including domain-specific colors.
 * Used internally by the theme system, not required for extension themes.
 */
export interface ExtendedThemeColors extends ThemeColors {
  // Code blocks
  'code-bg'?: string;
  'code-text'?: string;
  'code-border'?: string;
  'code-gutter'?: string;

  // Table
  'table-border'?: string;
  'table-header'?: string;
  'table-cell'?: string;
  'table-stripe'?: string;

  // Toolbar
  'toolbar-bg'?: string;
  'toolbar-border'?: string;
  'toolbar-hover'?: string;
  'toolbar-active'?: string;

  // Special
  'highlight-bg'?: string;
  'highlight-border'?: string;
  'quote-text'?: string;
  'quote-border'?: string;

  // Scrollbar
  'scrollbar-thumb'?: string;
  'scrollbar-thumb-hover'?: string;
  'scrollbar-track'?: string;

  // Diff
  'diff-add-bg'?: string;
  'diff-add-border'?: string;
  'diff-remove-bg'?: string;
  'diff-remove-border'?: string;

  // Syntax highlighting (code token colors)
  'code-comment'?: string;
  'code-punctuation'?: string;
  'code-property'?: string;
  'code-selector'?: string;
  'code-operator'?: string;
  'code-attr'?: string;
  'code-variable'?: string;
  'code-function'?: string;

  // Terminal
  'terminal-bg'?: string;
  'terminal-fg'?: string;
  'terminal-cursor'?: string;
  'terminal-cursor-accent'?: string;
  'terminal-selection'?: string;

  // Terminal ANSI standard colors (0-7)
  'terminal-ansi-black'?: string;
  'terminal-ansi-red'?: string;
  'terminal-ansi-green'?: string;
  'terminal-ansi-yellow'?: string;
  'terminal-ansi-blue'?: string;
  'terminal-ansi-magenta'?: string;
  'terminal-ansi-cyan'?: string;
  'terminal-ansi-white'?: string;

  // Terminal ANSI bright colors (8-15)
  'terminal-ansi-bright-black'?: string;
  'terminal-ansi-bright-red'?: string;
  'terminal-ansi-bright-green'?: string;
  'terminal-ansi-bright-yellow'?: string;
  'terminal-ansi-bright-blue'?: string;
  'terminal-ansi-bright-magenta'?: string;
  'terminal-ansi-bright-cyan'?: string;
  'terminal-ansi-bright-white'?: string;
}

/**
 * Theme definition.
 */
export interface Theme {
  /** Unique theme identifier */
  id: ThemeId;
  /** Display name for the theme */
  name: string;
  /** Whether this is a dark theme */
  isDark: boolean;
  /** Theme color values */
  colors: ExtendedThemeColors;
  /** Extension ID that contributed this theme (undefined for built-in) */
  contributedBy?: string;
  /**
   * Optional Monaco editor theme definition. Carried through from the
   * extension manifest so the renderer Monaco bridge can register it
   * via `monaco.editor.defineTheme()` when the registry changes.
   */
  monaco?: MonacoThemeContribution;
}

/**
 * Theme contribution in extension manifest.
 * Extensions only need to provide the colors they want to override.
 * Missing colors will fall back to the appropriate base theme (light or dark).
 */
export interface ThemeContribution {
  /** Unique theme ID within this extension (will be namespaced as extensionId:themeId) */
  id: string;
  /** Display name for the theme */
  name: string;
  /** Whether this is a dark theme (determines base theme for fallbacks) */
  isDark: boolean;
  /**
   * Theme color values. Only include colors you want to override.
   * Missing colors will fall back to the appropriate base theme (light or dark).
   */
  colors: Partial<ThemeColors>;
  /**
   * Optional Monaco editor theme definition. When present, the renderer
   * registers a matching Monaco theme so code editors honor the
   * extension's syntax-highlighting palette.
   */
  monaco?: MonacoThemeContribution;
}

/**
 * Theme change event payload.
 */
export interface ThemeChangeEvent {
  /** The new active theme */
  theme: Theme;
  /** The previous theme (undefined on initial load) */
  previousTheme?: Theme;
}

/**
 * Type guard to check if a theme ID is a built-in theme.
 */
export function isBuiltInTheme(id: ThemeId): id is BuiltInThemeId {
  return id === 'light' || id === 'dark';
}

/**
 * Extract the extension ID from a theme ID.
 * Returns undefined for built-in themes.
 */
export function getThemeExtensionId(themeId: ThemeId): string | undefined {
  if (isBuiltInTheme(themeId)) {
    return undefined;
  }
  const colonIndex = themeId.indexOf(':');
  if (colonIndex === -1) {
    return undefined;
  }
  return themeId.substring(0, colonIndex);
}
