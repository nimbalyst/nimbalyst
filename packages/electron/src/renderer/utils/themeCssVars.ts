// Kept out of useTheme.ts so the menu bar island entry can apply theme colors
// without importing the @nimbalyst/runtime barrel.
import type { ExtendedThemeColors } from '@nimbalyst/runtime/editor/themes/types';

/**
 * Map of ExtendedThemeColors keys to CSS variable names.
 *
 * These are the --nim-* variable names that components use directly.
 * Extension themes override these variables to change the look.
 */
export const CSS_VAR_MAP: Record<keyof ExtendedThemeColors, string> = {
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
  'comment-mark': '--nim-comment-mark',
  'quote-text': '--nim-quote-text',
  'quote-border': '--nim-quote-border',

  // Colored text palette
  'text-color-red': '--nim-text-color-red',
  'text-color-orange': '--nim-text-color-orange',
  'text-color-yellow': '--nim-text-color-yellow',
  'text-color-green': '--nim-text-color-green',
  'text-color-blue': '--nim-text-color-blue',
  'text-color-purple': '--nim-text-color-purple',
  'text-color-gray': '--nim-text-color-gray',
  'text-bg-red': '--nim-text-bg-red',
  'text-bg-orange': '--nim-text-bg-orange',
  'text-bg-yellow': '--nim-text-bg-yellow',
  'text-bg-green': '--nim-text-bg-green',
  'text-bg-blue': '--nim-text-bg-blue',
  'text-bg-purple': '--nim-text-bg-purple',
  'text-bg-gray': '--nim-text-bg-gray',

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
