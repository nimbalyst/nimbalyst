/**
 * ReadOnlyEditorHost factory for web share viewers.
 *
 * Creates a minimal EditorHost implementation that serves pre-loaded content
 * in read-only mode. Used by the Cloudflare share viewer to render extension
 * editors on the web without any Electron/IPC dependencies.
 *
 * Also useful for testing extensions in isolation.
 *
 * @example
 * ```ts
 * const host = createReadOnlyHost(decryptedContent, {
 *   theme: 'dark',
 *   fileName: 'diagram.mindmap',
 * });
 *
 * // Mount extension component
 * root.render(<MindmapEditor host={host} />);
 *
 * // Toggle theme from viewer chrome
 * host.setTheme('light');
 * ```
 */

import type { EditorHost, EditorContext, EditorMenuItem } from './types/editor.js';

export interface ReadOnlyHostOptions {
  /** Current theme name (e.g., 'dark', 'light') */
  theme: string;

  /** File name for display */
  fileName: string;

  /** Optional synthetic file path (defaults to `/shared/{fileName}`) */
  filePath?: string;

  /**
   * Whether this host represents an inline embed (vs. a full tab/share viewer).
   * When true, extensions may suppress chrome that doesn't fit inline contexts.
   */
  embedded?: boolean;
}

export interface ReadOnlyHost extends EditorHost {
  /** Update the theme (call from viewer chrome's theme toggle) */
  setTheme(theme: string): void;
}

/**
 * Create a read-only EditorHost that serves pre-loaded content.
 *
 * All mutating methods (save, dirty, file change) are no-ops.
 * The `readOnly` flag is set to `true` so extensions can check it
 * to disable editing UI.
 */
export function createReadOnlyHost(
  content: string,
  opts: ReadOnlyHostOptions,
): ReadOnlyHost {
  let themeCallbacks: ((theme: string) => void)[] = [];
  let currentTheme = opts.theme;

  const host: ReadOnlyHost = {
    // -- File info --
    filePath: opts.filePath ?? `/shared/${opts.fileName}`,
    fileName: opts.fileName,
    readOnly: true,
    embedded: opts.embedded ?? false,
    theme: currentTheme,
    isActive: true,

    // -- Content loading --
    loadContent: async () => content,
    loadBinaryContent: async () => new TextEncoder().encode(content).buffer,

    // -- Theme --
    onThemeChanged: (cb: (theme: string) => void) => {
      themeCallbacks.push(cb);
      return () => {
        themeCallbacks = themeCallbacks.filter((c) => c !== cb);
      };
    },

    // -- No-ops for read-only --
    saveContent: async () => {},
    setDirty: () => {},
    onSaveRequested: () => () => {},
    onFileChanged: () => () => {},
    // readOnly never flips for the share viewer; the callback is held but
    // never invoked.
    onReadOnlyChanged: () => () => {},
    openHistory: () => {},
    registerMenuItems: (_items: EditorMenuItem[]) => {},
    registerEditorAPI: () => {},
    setEditorContext: (_context: EditorContext | null) => {},

    // -- Storage (in-memory, non-persistent) --
    storage: {
      get: <T>(_key: string): T | undefined => undefined,
      set: async () => {},
      delete: async () => {},
      getGlobal: <T>(_key: string): T | undefined => undefined,
      setGlobal: async () => {},
      deleteGlobal: async () => {},
      getSecret: async () => undefined,
      setSecret: async () => {},
      deleteSecret: async () => {},
    },

    // -- Theme toggle for viewer chrome --
    setTheme(theme: string) {
      currentTheme = theme;
      // Update the host's own theme property
      (host as { theme: string }).theme = theme;
      themeCallbacks.forEach((cb) => cb(theme));
    },
  };

  return host;
}
