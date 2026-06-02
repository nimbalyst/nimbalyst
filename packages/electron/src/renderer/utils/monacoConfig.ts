/**
 * Monaco Editor configuration for Electron
 *
 * Configures Monaco to use local resources instead of CDN
 * Uses Vite's native worker support for web workers
 */

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import {
  getThemesWithMonacoDefinition,
  onThemesChanged,
  MONACO_BASE_THEMES,
  toMonacoExtensionThemeName,
  type MonacoThemeContribution,
} from '@nimbalyst/runtime';

// Import workers using Vite's ?worker syntax
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';

// Track registered custom themes (built-in + extension-contributed)
const registeredThemes = new Set<string>();

/**
 * Define custom Monaco themes for extension themes.
 * This must be called after Monaco is loaded.
 */
function defineCustomMonacoThemes(): void {
  // Solarized Light theme
  monaco.editor.defineTheme('solarized-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '93a1a1', fontStyle: 'italic' },
      { token: 'keyword', foreground: '859900' },
      { token: 'string', foreground: '2aa198' },
      { token: 'number', foreground: 'd33682' },
      { token: 'type', foreground: 'b58900' },
      { token: 'class', foreground: 'b58900' },
      { token: 'function', foreground: '268bd2' },
      { token: 'variable', foreground: '268bd2' },
      { token: 'constant', foreground: 'cb4b16' },
      { token: 'parameter', foreground: '657b83' },
      { token: 'punctuation', foreground: '657b83' },
      { token: 'operator', foreground: '657b83' },
    ],
    colors: {
      'editor.background': '#fdf6e3',
      'editor.foreground': '#657b83',
      'editor.selectionBackground': '#eee8d5',
      'editor.lineHighlightBackground': '#eee8d5',
      'editorCursor.foreground': '#657b83',
      'editorWhitespace.foreground': '#93a1a1',
      'editorLineNumber.foreground': '#93a1a1',
      'editorLineNumber.activeForeground': '#657b83',
      'editor.selectionHighlightBackground': '#eee8d580',
      'editorIndentGuide.background': '#eee8d5',
      'editorIndentGuide.activeBackground': '#93a1a1',
      'editorBracketMatch.background': '#eee8d5',
      'editorBracketMatch.border': '#93a1a1',
    }
  });
  registeredThemes.add('solarized-light');

  // Solarized Dark theme
  monaco.editor.defineTheme('solarized-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '586e75', fontStyle: 'italic' },
      { token: 'keyword', foreground: '859900' },
      { token: 'string', foreground: '2aa198' },
      { token: 'number', foreground: 'd33682' },
      { token: 'type', foreground: 'b58900' },
      { token: 'class', foreground: 'b58900' },
      { token: 'function', foreground: '268bd2' },
      { token: 'variable', foreground: '268bd2' },
      { token: 'constant', foreground: 'cb4b16' },
      { token: 'parameter', foreground: '839496' },
      { token: 'punctuation', foreground: '839496' },
      { token: 'operator', foreground: '839496' },
    ],
    colors: {
      'editor.background': '#002b36',
      'editor.foreground': '#839496',
      'editor.selectionBackground': '#073642',
      'editor.lineHighlightBackground': '#073642',
      'editorCursor.foreground': '#839496',
      'editorWhitespace.foreground': '#586e75',
      'editorLineNumber.foreground': '#586e75',
      'editorLineNumber.activeForeground': '#839496',
      'editor.selectionHighlightBackground': '#07364280',
      'editorIndentGuide.background': '#073642',
      'editorIndentGuide.activeBackground': '#586e75',
      'editorBracketMatch.background': '#073642',
      'editorBracketMatch.border': '#586e75',
    }
  });
  registeredThemes.add('solarized-dark');

  // Monokai theme
  monaco.editor.defineTheme('monokai', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '75715e', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'f92672' },
      { token: 'string', foreground: 'e6db74' },
      { token: 'number', foreground: 'ae81ff' },
      { token: 'type', foreground: '66d9ef', fontStyle: 'italic' },
      { token: 'class', foreground: 'a6e22e' },
      { token: 'function', foreground: 'a6e22e' },
      { token: 'variable', foreground: 'f8f8f2' },
      { token: 'constant', foreground: 'ae81ff' },
      { token: 'parameter', foreground: 'fd971f', fontStyle: 'italic' },
      { token: 'punctuation', foreground: 'f8f8f2' },
      { token: 'operator', foreground: 'f92672' },
    ],
    colors: {
      'editor.background': '#272822',
      'editor.foreground': '#f8f8f2',
      'editor.selectionBackground': '#49483e',
      'editor.lineHighlightBackground': '#3e3d32',
      'editorCursor.foreground': '#f8f8f0',
      'editorWhitespace.foreground': '#75715e',
      'editorLineNumber.foreground': '#90908a',
      'editorLineNumber.activeForeground': '#f8f8f2',
      'editor.selectionHighlightBackground': '#49483e80',
      'editorIndentGuide.background': '#3e3d32',
      'editorIndentGuide.activeBackground': '#75715e',
      'editorBracketMatch.background': '#3e3d32',
      'editorBracketMatch.border': '#75715e',
    }
  });
  registeredThemes.add('monokai');

  console.log('[Monaco] Custom themes defined:', Array.from(registeredThemes));
}

/**
 * Define a single Monaco theme from an extension contribution. The
 * caller is responsible for passing a Monaco-legal theme name (see
 * `toMonacoExtensionThemeName`); Monaco's `defineTheme` throws on names
 * that don't match `/^[a-z0-9\-]+$/`. Idempotent -- redefining the same
 * id is allowed (Monaco overwrites).
 */
function defineExtensionMonacoTheme(monacoThemeName: string, def: MonacoThemeContribution): void {
  monaco.editor.defineTheme(monacoThemeName, {
    base: def.base,
    inherit: def.inherit ?? true,
    rules: def.rules,
    colors: def.colors,
  });
  registeredThemes.add(monacoThemeName);
}

/**
 * Walk the runtime theme registry and register a Monaco theme for every
 * entry that carries a `monaco` block. Safe to call repeatedly; each
 * call replaces previously-registered definitions.
 *
 * The extension theme id (e.g. `com.acme.themes:dracula`) is sanitized
 * via `toMonacoExtensionThemeName` because Monaco rejects theme names
 * with `.` or `:`. `getMonacoTheme` runs the same transform on the
 * lookup side so `setTheme` finds the registered entry.
 */
function syncMonacoThemesFromRegistry(): void {
  for (const theme of getThemesWithMonacoDefinition()) {
    const monacoName = toMonacoExtensionThemeName(theme.id);
    try {
      defineExtensionMonacoTheme(monacoName, theme.monaco!);
    } catch (error) {
      console.error(`[Monaco] Failed to register extension theme '${theme.id}' (as '${monacoName}'):`, error);
    }
  }
}

/**
 * Check if a Monaco theme name is registered (custom or built-in)
 */
export function isMonacoThemeRegistered(themeName: string): boolean {
  return registeredThemes.has(themeName) || (MONACO_BASE_THEMES as readonly string[]).includes(themeName);
}

/**
 * Initialize Monaco Editor for Electron environment
 * Configures @monaco-editor/react to use the local npm package
 */
let monacoInitialized = false;

export function initMonacoEditor(): void {
  if (monacoInitialized) {
    // Guards against a hot-reload or accidental re-call doubling up
    // listeners on the theme registry.
    return;
  }
  monacoInitialized = true;

  console.log('[Monaco] Initializing Monaco Editor for Electron');

  // Configure Monaco environment with worker factory
  // This uses Vite's native worker support instead of a plugin
  self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      if (label === 'json') {
        return new jsonWorker();
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new cssWorker();
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new htmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker();
      }
      return new editorWorker();
    }
  };

  // Configure @monaco-editor/react to use the local npm package instead of CDN
  loader.config({ monaco });

  // Define built-in custom themes (solarized, monokai) after Monaco is configured
  defineCustomMonacoThemes();

  // Pick up any extension-contributed Monaco themes already in the
  // registry, then subscribe so future extension loads/unloads
  // re-register their Monaco definitions.
  syncMonacoThemesFromRegistry();
  onThemesChanged(syncMonacoThemesFromRegistry);

  console.log('[Monaco] Configuration complete');
}
