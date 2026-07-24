/**
 * EditorHost factory for inline embeds.
 *
 * Differs from `@nimbalyst/extension-sdk` `createReadOnlyHost` in three
 * ways:
 *   1. `loadContent` reads bytes from disk through the workspace IPC, so
 *      embeds get the live file contents, not a baked-in snapshot.
 *   2. `onFileChanged` is wired to the renderer's file watcher subscription
 *      (Jotai atom family) so the embed reloads when the embedded file
 *      changes -- whether the user edited it in another tab or AI rewrote
 *      it. This is the "alive" property that distinguishes an embed from
 *      a Mermaid snapshot.
 *   3. `saveContent` writes back to disk when the host is in edit mode.
 *      `setDirty` flows to the embed's autosave timer; `onSaveRequested`
 *      lets the extension hook the timer's "save now" signal. In view
 *      mode all three are no-ops -- the embed is purely a viewer.
 *
 * History snapshots / menu items / editor-context wiring are still no-ops:
 * they make no sense for an inline embed. (Phase 6 of the embed plan adds
 * a richer history pane affordance.)
 */

import type {
  EditorHost,
  EditorContext,
  EditorMenuItem,
} from '@nimbalyst/runtime';

export interface EmbeddedFileHostOptions {
  /** Absolute path of the embedded file. */
  embedPath: string;
  /** Whether the embedded editor should consider itself the active surface. */
  isActive?: boolean;
  /** Workspace identifier (workspace path); used for storage scoping. */
  workspaceId?: string;
  /** Returns the current theme name. */
  getTheme(): string;
  /** Subscribes to global theme changes, returns unsubscribe. */
  subscribeToThemeChanges(cb: (theme: string) => void): () => void;
  /**
   * Subscribes to file-change events for `absolutePath`. Callback fires
   * (with the new content) after the renderer's watcher has observed a
   * change on disk for that path. Returns unsubscribe.
   */
  subscribeToFileChanges(
    absolutePath: string,
    cb: (content: string) => void,
  ): () => void;
  /** Reads the embed file from disk. */
  readFile(absolutePath: string): Promise<string>;
  /**
   * Writes content to the embedded file. Called by extensions during a
   * save flow (autosave or `host.onSaveRequested` callback). Implementer
   * should also mark the path in the host's save-echo dedup map so the
   * file watcher's resulting `onFileChanged` for this path is ignored.
   */
  saveFile(absolutePath: string, content: string | ArrayBuffer): Promise<void>;
  /**
   * Returns the current read-only flag. Read-only embeds are the default;
   * the chrome's View/Edit toggle flips this so extensions that respect
   * `host.readOnly` (e.g. Excalidraw's `viewModeEnabled`) can hide their
   * editing UI in view mode.
   */
  getReadOnly(): boolean;
  /**
   * Subscribes to changes to the read-only flag. The callback receives the
   * new value whenever the user flips the toggle. Returns unsubscribe.
   */
  subscribeToReadOnlyChanges(cb: (readOnly: boolean) => void): () => void;
  /**
   * Called by the host (extension) whenever its dirty state changes.
   * EmbedFrame records this so it can drive the autosave timer and show
   * a dirty indicator in the chrome.
   */
  onDirtyChange(isDirty: boolean): void;
  /**
   * Registers a save-request handler. EmbedFrame's autosave timer (and a
   * future Cmd+S binding) invokes these callbacks to ask the extension
   * to save now. Returns unsubscribe.
   */
  subscribeToSaveRequests(cb: () => void): () => void;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.substring(i + 1) : p;
}

export function createEmbeddedFileHost(
  opts: EmbeddedFileHostOptions,
): EditorHost {
  const fileName = basename(opts.embedPath);

  const host: EditorHost = {
    filePath: opts.embedPath,
    fileName,
    embedded: true,
    workspaceId: opts.workspaceId,
    get theme() {
      return opts.getTheme();
    },
    get readOnly() {
      return opts.getReadOnly();
    },
    isActive: opts.isActive ?? true,

    onThemeChanged(cb) {
      return opts.subscribeToThemeChanges(cb);
    },

    onReadOnlyChanged(cb) {
      return opts.subscribeToReadOnlyChanges(cb);
    },

    loadContent: () => opts.readFile(opts.embedPath),
    loadBinaryContent: async () => {
      const content = await opts.readFile(opts.embedPath);
      return new TextEncoder().encode(content).buffer;
    },

    onFileChanged(cb) {
      return opts.subscribeToFileChanges(opts.embedPath, cb);
    },

    // In view mode the chrome ignores the dirty signal and never fires
    // save requests; in edit mode EmbedFrame's autosave timer drives the
    // flow. The extension doesn't need to know which mode it's in -- it
    // just calls setDirty/saveContent as usual.
    async saveContent(content) {
      if (opts.getReadOnly()) {
        // Hard guard: a misbehaving extension still won't clobber disk
        // while the user is in view mode.
        return;
      }
      await opts.saveFile(opts.embedPath, content);
    },
    setDirty(isDirty) {
      opts.onDirtyChange(isDirty);
    },
    onSaveRequested(cb) {
      return opts.subscribeToSaveRequests(cb);
    },
    openHistory: () => {},
    registerMenuItems: (_items: EditorMenuItem[]) => {},
    registerEditorAPI: () => {},
    setEditorContext: (_ctx: EditorContext | null) => {},
    setEditorContextItems: () => {},

    // Storage is a non-persistent stub. Per-embed preferences are out of
    // scope for Phase 1; if/when extensions need them we can route to the
    // host doc's tab storage.
    storage: {
      get: <T,>(_key: string): T | undefined => undefined,
      set: async () => {},
      delete: async () => {},
      getGlobal: <T,>(_key: string): T | undefined => undefined,
      setGlobal: async () => {},
      deleteGlobal: async () => {},
      getSecret: async () => undefined,
      setSecret: async () => {},
      deleteSecret: async () => {},
    },
  };

  return host;
}
