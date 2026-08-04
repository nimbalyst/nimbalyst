/**
 * Built-in theme color tables.
 *
 * Deliberately free of registry state — no Map, no listeners, no active theme.
 * Importing this module runs nothing but two object literals, so hosts that
 * only need the palette (the web console) can take the colors without also
 * booting the desktop theme registry and its `@nimbalyst/extension-sdk` edge.
 * `registry.ts` is the only consumer that layers mutable state on top.
 */

import type { ExtendedThemeColors } from './types';

/**
 * Built-in light theme colors.
 */
export const lightThemeColors: ExtendedThemeColors = {
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
  'on-primary': '#ffffff',

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
  'comment-mark': '#ffd400',
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
export const darkThemeColors: ExtendedThemeColors = {
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
  'on-primary': '#0b1220',

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
  // Warmer, lighter gold reads as an intentional highlight on dark backgrounds
  // instead of the muddy olive that saturated yellow blends into.
  'comment-mark': '#ffd27a',
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

/**
 * Get the base theme colors for a given dark mode preference.
 * Used for merging extension theme contributions with base colors.
 */
export function getBaseThemeColors(isDark: boolean): ExtendedThemeColors {
  return isDark ? darkThemeColors : lightThemeColors;
}
