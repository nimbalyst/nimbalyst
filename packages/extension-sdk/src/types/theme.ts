/**
 * Core types for Nimbalyst theme system.
 *
 * Themes are separate from extensions - they provide styling only, no code.
 * This module defines the schema for theme.json manifests and theme metadata.
 */

/**
 * Available theme color keys that can be overridden.
 * These map to CSS variables (--nim-*) used throughout the UI.
 */
export type ThemeColorKey =
  // Background hierarchy
  | 'bg' | 'bg-secondary' | 'bg-tertiary' | 'bg-hover' | 'bg-selected' | 'bg-active'
  // Text variants
  | 'text' | 'text-muted' | 'text-faint' | 'text-disabled'
  // Borders
  | 'border' | 'border-focus'
  // Primary/brand colors
  | 'primary' | 'primary-hover'
  // Links
  | 'link' | 'link-hover'
  // Status colors
  | 'success' | 'warning' | 'error' | 'info';

/**
 * Theme color values.
 * All colors are optional - missing colors will fall back to base theme.
 */
export type ThemeColors = Partial<Record<ThemeColorKey, string>>;

/**
 * Built-in Monaco theme ids accepted as the `base` field on a
 * `MonacoThemeContribution`. Single source of truth -- the manifest
 * validator, the renderer registry helper, and consumer-facing docs
 * all derive from this list.
 */
export const MONACO_BASE_THEMES = ['vs', 'vs-dark', 'hc-black', 'hc-light'] as const;
export type MonacoBaseTheme = typeof MONACO_BASE_THEMES[number];

/**
 * Monaco editor token rule -- mirrors monaco-editor's
 * `editor.ITokenThemeRule`. Keeping the shape redeclared (rather than
 * importing from monaco-editor) so extension manifests can be validated
 * and processed in contexts that don't bundle Monaco.
 */
export interface MonacoTokenRule {
  /** Token id (e.g. 'comment', 'keyword.js', 'string.escape') */
  token: string;
  /** Hex color WITHOUT leading '#' (Monaco convention) */
  foreground?: string;
  /** Hex color WITHOUT leading '#' */
  background?: string;
  /** Space-separated styles: 'italic', 'bold', 'underline' */
  fontStyle?: string;
}

/**
 * Monaco editor theme contribution embedded in a ThemeContribution.
 * When present, the runtime registers a matching Monaco theme via
 * `monaco.editor.defineTheme()` and routes Monaco-backed editors
 * (code files, JSON, etc.) to use it.
 *
 * `base` selects the Monaco built-in theme to inherit from. `rules`
 * carries token-level color rules; `colors` carries Monaco's
 * editor.* color keys (e.g. 'editor.background').
 */
export interface MonacoThemeContribution {
  /** Built-in Monaco theme used as the base for inheritance */
  base: MonacoBaseTheme;
  /**
   * Whether to inherit unspecified rules/colors from `base`.
   * Defaults to true (matches Monaco's `defineTheme` default).
   */
  inherit?: boolean;
  /** Token rules applied to syntax-highlighted text */
  rules: MonacoTokenRule[];
  /**
   * Editor color overrides keyed by Monaco color id
   * (e.g. 'editor.background', 'editor.foreground').
   */
  colors: Record<string, string>;
}

/**
 * Where a theme entry returned by `theme:list` originated from.
 */
export type ThemeManifestOrigin = 'builtin' | 'user' | 'extension';

/**
 * Theme manifest schema (theme.json).
 * This is the schema for standalone theme packages.
 *
 * The same shape is also returned by the runtime `theme:list` IPC for
 * extension-contributed themes, with `origin` and `contributedBy` populated.
 */
export interface ThemeManifest {
  /** Unique theme identifier (e.g., 'solarized-dark') */
  id: string;

  /** Display name shown in UI */
  name: string;

  /** Semantic version */
  version: string;

  /** Theme author name or organization */
  author?: string;

  /** Brief description */
  description?: string;

  /** Whether this is a dark theme (determines base theme for fallbacks) */
  isDark: boolean;

  /**
   * Theme color overrides.
   * Only include colors you want to override from the base theme.
   * All color values must be valid hex codes or CSS color names.
   */
  colors: ThemeColors;

  /** Path to preview image (relative to theme.json) */
  preview?: string;

  /** Tags for discovery and filtering */
  tags?: string[];

  /** License identifier (SPDX) */
  license?: string;

  /** Homepage or repository URL */
  homepage?: string;

  /**
   * Where this theme came from. Populated by the runtime when listing themes.
   * Not part of the on-disk theme.json schema.
   */
  origin?: ThemeManifestOrigin;

  /**
   * Extension ID that contributed this theme (only set when `origin === 'extension'`).
   * Not part of the on-disk theme.json schema.
   */
  contributedBy?: string;
}

/**
 * Full theme object with metadata and resolved colors.
 * This is what's used at runtime after loading a theme.
 */
export interface Theme {
  /** Theme ID (unique across all themes) */
  id: string;

  /** Display name */
  name: string;

  /** Semantic version */
  version: string;

  /** Author */
  author?: string;

  /** Description */
  description?: string;

  /** Is dark theme */
  isDark: boolean;

  /** Resolved color values (merged with base theme) */
  colors: ThemeColors;

  /** Tags */
  tags?: string[];

  /** Preview image path (absolute) */
  previewPath?: string;

  /** Source of the theme */
  source: ThemeSource;
}

/**
 * Where the theme came from.
 */
export type ThemeSource =
  | { type: 'builtin' }                      // Built-in theme (light, dark)
  | { type: 'user'; installPath: string }    // User-installed theme
  | { type: 'extension'; extensionId: string }; // Theme from extension (deprecated)

/**
 * Marketplace theme metadata.
 * Used for browsing and discovering themes before installation.
 */
export interface MarketplaceTheme {
  /** Theme ID */
  id: string;

  /** Display name */
  name: string;

  /** Author */
  author: string;

  /** Version */
  version: string;

  /** Description */
  description: string;

  /** Download count */
  downloads: number;

  /** Average rating (0-5) */
  rating: number;

  /** Tags */
  tags: string[];

  /** URL to preview image */
  preview: string;

  /** URL to download .nimtheme file */
  downloadUrl: string;

  /** Last update timestamp */
  lastUpdated: string;

  /** License */
  license?: string;

  /** Homepage URL */
  homepage?: string;
}

/**
 * Theme validation result.
 */
export interface ThemeValidationResult {
  /** Whether the theme is valid */
  valid: boolean;

  /** Validation errors (if any) */
  errors: string[];

  /** Validation warnings (non-fatal) */
  warnings: string[];
}

/**
 * Theme installation options.
 */
export interface ThemeInstallOptions {
  /** Path to .nimtheme file or directory */
  source: string;

  /** Whether to overwrite existing theme with same ID */
  overwrite?: boolean;
}

/**
 * Theme uninstall options.
 */
export interface ThemeUninstallOptions {
  /** Theme ID to uninstall */
  themeId: string;

  /** Whether to keep theme files (just disable) */
  keepFiles?: boolean;
}
