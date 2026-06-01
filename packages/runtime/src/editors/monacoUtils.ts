/**
 * Monaco Editor Utilities
 *
 * Shared utilities for Monaco editor integration.
 */

import type { ConfigTheme } from '../editor';
import { getTheme } from '../editor/themes/registry';

/**
 * Static map of theme IDs to their Monaco theme names.
 * Covers the built-in solarized/monokai themes registered in
 * monacoConfig.ts as well as the legacy namespaced IDs they used to ship
 * under. Extension-contributed themes are resolved dynamically via the
 * theme registry below.
 */
const BUILTIN_THEME_TO_MONACO: Record<string, string> = {
  // Current built-in theme IDs
  'solarized-light': 'solarized-light',
  'solarized-dark': 'solarized-dark',
  'monokai': 'monokai',

  // Legacy IDs used when these themes shipped as an extension
  'sample-themes:solarized-light': 'solarized-light',
  'sample-themes:solarized-dark': 'solarized-dark',
  'sample-themes:monokai': 'monokai',
};

/**
 * Map Nimbalyst theme to Monaco editor theme.
 *
 * Resolution order for `extensionThemeId`:
 *   1. Built-in/legacy mapping in `BUILTIN_THEME_TO_MONACO`.
 *   2. Registry lookup -- if the theme is registered and carries a
 *      `monaco` definition, the namespaced theme id IS the Monaco theme
 *      name (the renderer bridge registers it under that id).
 *   3. Fallback to base Monaco theme using `isDark` / `nimbalystTheme`.
 *
 * Monaco built-in themes:
 *   - 'vs'        : light
 *   - 'vs-dark'   : dark
 *   - 'hc-black'  : high contrast dark
 *   - 'hc-light'  : high contrast light
 */
export function getMonacoTheme(nimbalystTheme: ConfigTheme, isDark?: boolean, extensionThemeId?: string): string {
  if (extensionThemeId) {
    const builtin = BUILTIN_THEME_TO_MONACO[extensionThemeId];
    if (builtin) {
      return builtin;
    }

    // Extension-contributed Monaco theme: the bridge registers the
    // theme under its namespaced id, so we can return it verbatim.
    const registered = getTheme(extensionThemeId);
    if (registered?.monaco) {
      return extensionThemeId;
    }
  }

  switch (nimbalystTheme) {
    case 'light':
      return 'vs';

    case 'dark':
    case 'crystal-dark':
      return 'vs-dark';

    case 'auto':
      // Auto theme should check system preference
      // For now, default to light (TabEditor should resolve 'auto' before passing to Monaco)
      return 'vs';

    default:
      // Extension themes or unknown themes - use isDark flag if provided
      if (isDark !== undefined) {
        return isDark ? 'vs-dark' : 'vs';
      }
      // Fall back to light for unknown themes
      return 'vs';
  }
}

/**
 * Browser-compatible path utilities
 */
function getExtname(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash && lastDot > 0) {
    return filePath.substring(lastDot);
  }
  return '';
}

function getBasename(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
}

/**
 * Map file extension to Monaco editor language ID
 */
export function getMonacoLanguage(filePath: string): string {
  const ext = getExtname(filePath).toLowerCase();

  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.d.ts': 'typescript',

    // Web
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',

    // Data formats
    '.json': 'json',
    '.jsonc': 'json',
    '.xml': 'xml',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'ini',

    // Python
    '.py': 'python',
    '.pyw': 'python',
    '.pyi': 'python',

    // Shell
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.fish': 'shell',

    // C/C++
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hxx': 'cpp',

    // Other compiled languages
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.kt': 'kotlin',
    '.swift': 'swift',
    '.cs': 'csharp',

    // Scripting
    '.rb': 'ruby',
    '.php': 'php',
    '.pl': 'perl',
    '.lua': 'lua',

    // Functional
    '.hs': 'haskell',
    '.scala': 'scala',
    '.clj': 'clojure',
    '.fs': 'fsharp',
    '.fsx': 'fsharp',

    // Markup/Config
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.sql': 'sql',
    '.graphql': 'graphql',
    '.dockerfile': 'dockerfile',
    '.dockerignore': 'plaintext',
    '.gitignore': 'plaintext',
    '.env': 'plaintext',

    // Text
    '.txt': 'plaintext',
    '.log': 'plaintext',
  };

  // Special case: files without extensions
  if (!ext) {
    const basename = getBasename(filePath);
    if (basename === 'Dockerfile') return 'dockerfile';
    if (basename === 'Makefile') return 'makefile';
    if (basename === 'Gemfile') return 'ruby';
    return 'plaintext';
  }

  return languageMap[ext] || 'plaintext';
}
