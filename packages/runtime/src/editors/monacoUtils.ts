/**
 * Monaco Editor Utilities
 *
 * Shared utilities for Monaco editor integration.
 */

import type { ConfigTheme } from '../editor';
import { getTheme } from '../editor/themes/registry';

/**
 * Pick the Monaco theme name to use for an extension-contributed theme.
 *
 * Monaco's `editor.defineTheme()` enforces `/^[a-z0-9\-]+$/` on theme
 * names and silently falls back to `vs` (light) in `setTheme()` when an
 * unknown name is passed. Our namespaced extension ids -- e.g.
 * `com.rosepinetheme.nimbalyst:rose-pine` -- contain `.` and `:`, which
 * violate the regex.
 *
 * The manifest validator already pins `contribution.id` (the part after
 * the namespace) to `/^[a-z0-9][a-z0-9-]*$/`, which is a strict subset
 * of Monaco's accepted shape. So taking the part after the final `:` is
 * always a Monaco-legal name and matches the id the extension author
 * actually wrote in the manifest, which keeps log messages and devtools
 * inspection readable. The trade-off: two extensions that declare the
 * same theme id (e.g. both ship `id: "monokai"`) collide and the second
 * registration overwrites the first inside Monaco. Monaco itself allows
 * the redefinition without error, and the UI shell still distinguishes
 * the themes via the namespaced id, so this is acceptable in practice.
 */
export function toMonacoExtensionThemeName(extensionThemeId: string): string {
  const colonIndex = extensionThemeId.lastIndexOf(':');
  return colonIndex >= 0 ? extensionThemeId.substring(colonIndex + 1) : extensionThemeId;
}

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
    // theme under a sanitized name (see toMonacoExtensionThemeName for
    // why) and we have to hand that exact same name to Monaco's
    // setTheme, otherwise Monaco silently falls back to `vs`.
    const registered = getTheme(extensionThemeId);
    if (registered?.monaco) {
      return toMonacoExtensionThemeName(extensionThemeId);
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
