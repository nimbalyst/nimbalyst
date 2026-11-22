/**
 * The `EditorHost` an extension editor (drawing, mind map, spreadsheet...) gets
 * in the browser view: the editors' own local-file path, with the file read and
 * written through `nim wiki serve` instead of the disk.
 *
 * - `loadContent` reads `GET /api/pages/:id/body` and remembers its version.
 * - `saveContent` writes with that version; the server refuses (409) when the
 *   file changed since, and the host holds a conflict until the person picks
 *   which text wins (`resolveConflict`). Nothing is overwritten or dropped
 *   silently.
 * - A change event for the page re-reads it. Our own write coming back has the
 *   version we already hold and is ignored; with no unsaved edits the new text
 *   goes to the editor (`onFileChanged`), otherwise it is the same conflict.
 * - Saving is driven from here, as on desktop: the editor marks itself dirty,
 *   the host asks it to save after a short pause (`onSaveRequested`), and the
 *   editor calls `saveContent`.
 *
 * No collaboration, no project filesystem: an editor sees a host that edits one
 * file.
 */
import type { ComponentProps } from 'react';
import type { ExtensionEditorComponent } from '@nimbalyst/collab-bundle/editor';
import type { ReadBodyResult, WriteBodyResult } from '@nimbalyst/local-wiki';
import type { WikiFeedEvent } from '../api/client';

export type EditorHost = ComponentProps<ExtensionEditorComponent>['host'];

export interface WikiBodyApi {
  readBody(pageId: string): Promise<ReadBodyResult>;
  writeBody(pageId: string, text: string, expectedVersion: string | null): Promise<WriteBodyResult>;
}

export interface WikiChangeSource {
  subscribe(listener: (event: WikiFeedEvent) => void): () => void;
}

export interface WikiFileConflict {
  diskText: string;
  diskVersion: string;
}

export interface WikiFileEditorState {
  dirty: boolean;
  saving: boolean;
  conflict: WikiFileConflict | null;
  error: string | null;
}

export interface WikiFileEditorHost extends EditorHost {
  getState(): WikiFileEditorState;
  subscribeState(listener: (state: WikiFileEditorState) => void): () => void;
  /** Ask the editor to save now (Cmd+S, leaving the page). Resolves when its save settled. */
  requestSave(): Promise<void>;
  /** `theirs` loads the file into the editor; `mine` writes the editor's text over it. */
  resolveConflict(choice: 'theirs' | 'mine'): Promise<void>;
  setTheme(theme: string): void;
  dispose(): void;
}

export interface WikiFileEditorHostOptions {
  pageId: string;
  fileName: string;
  /** Shown to editors as `filePath`; an opaque identity here, nothing reads the disk through it. */
  filePath: string;
  theme: string;
  api: WikiBodyApi;
  changes: WikiChangeSource;
  /** Pause after the last edit before the host asks the editor to save. */
  autosaveDelayMs?: number;
  /** Shown inside another page (a canvas card) rather than as the page itself. */
  embedded?: boolean;
  /** A static export: the editor is told so, and nothing is ever marked dirty or written. */
  readOnly?: boolean;
}

/** A write the server refused because the file changed; the editor keeps its edits. */
export class WikiFileConflictError extends Error {
  constructor() {
    super('The file changed on disk since it was opened');
    this.name = 'WikiFileConflictError';
  }
}

const noop = () => {};

export function createWikiFileEditorHost(options: WikiFileEditorHostOptions): WikiFileEditorHost {
  const { pageId, api, changes } = options;
  const autosaveDelayMs = options.autosaveDelayMs ?? 800;
  const readOnly = options.readOnly ?? false;
  let theme = options.theme;
  let version: string | null = null;
  let state: WikiFileEditorState = { dirty: false, saving: false, conflict: null, error: null };
  let autosave: ReturnType<typeof setTimeout> | null = null;
  /** The write in flight; a change event waits for it before comparing versions. */
  let writing: Promise<unknown> = Promise.resolve();
  let disposed = false;
  /** Bumped by every `setDirty(true)`, so a write knows whether edits landed while it ran. */
  let dirtyMarks = 0;

  const stateListeners = new Set<(next: WikiFileEditorState) => void>();
  const themeListeners = new Set<(next: string) => void>();
  const fileListeners = new Set<(text: string) => void>();
  const saveListeners = new Set<() => void | Promise<void>>();
  const storage = new Map<string, unknown>();

  const setState = (patch: Partial<WikiFileEditorState>) => {
    state = { ...state, ...patch };
    for (const listener of [...stateListeners]) listener(state);
  };

  const cancelAutosave = () => {
    if (autosave) clearTimeout(autosave);
    autosave = null;
  };

  const requestSave = async () => {
    cancelAutosave();
    // A clean page has nothing to write; asking anyway rewrites the file from
    // whatever the editor holds, which on the way out can be a torn-down scene.
    if (state.conflict || !state.dirty) return;
    await Promise.all([...saveListeners].map((listener) => Promise.resolve(listener()).catch(noop)));
  };

  const deliver = (text: string) => {
    for (const listener of [...fileListeners]) listener(text);
  };

  const onDiskChange = async () => {
    await writing.catch(noop);
    if (disposed) return;
    let body: ReadBodyResult;
    try {
      body = await api.readBody(pageId);
    } catch {
      return; // Trashed or moved away; the tree's refresh shows that.
    }
    if (disposed || body.version === version) return;
    if (state.dirty || state.conflict) {
      setState({ conflict: { diskText: body.markdown, diskVersion: body.version } });
      return;
    }
    version = body.version;
    deliver(body.markdown);
  };

  const unsubscribeChanges = changes.subscribe((event) => {
    if (event.type === 'ready' && version !== null) void onDiskChange();
    if (event.type === 'change' && event.change.changedIds.includes(pageId)) void onDiskChange();
  });

  const host: WikiFileEditorHost = {
    filePath: options.filePath,
    fileName: options.fileName,
    get theme() {
      return theme;
    },
    isActive: true,
    visible: true,
    readOnly,
    embedded: options.embedded ?? false,

    async loadContent() {
      const body = await api.readBody(pageId);
      version = body.version;
      return body.markdown;
    },
    async loadBinaryContent() {
      const body = await api.readBody(pageId);
      version = body.version;
      return new TextEncoder().encode(body.markdown).buffer as ArrayBuffer;
    },

    onFileChanged(callback) {
      fileListeners.add(callback);
      return () => fileListeners.delete(callback);
    },
    onThemeChanged(callback) {
      themeListeners.add(callback);
      return () => themeListeners.delete(callback);
    },
    onSaveRequested(callback) {
      saveListeners.add(callback);
      return () => saveListeners.delete(callback);
    },

    setDirty(dirty) {
      if (readOnly) return;
      if (dirty) dirtyMarks += 1;
      if (dirty === state.dirty) {
        if (dirty && !autosave && !state.conflict) autosave = setTimeout(() => void requestSave(), autosaveDelayMs);
        return;
      }
      setState({ dirty });
      cancelAutosave();
      if (dirty && !state.conflict) autosave = setTimeout(() => void requestSave(), autosaveDelayMs);
    },

    saveContent(content) {
      if (readOnly) return Promise.resolve();
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      const run = writing.catch(noop).then(async () => {
        if (state.conflict) throw new WikiFileConflictError();
        const marksAtStart = dirtyMarks;
        setState({ saving: true });
        try {
          const result = await api.writeBody(pageId, text, version);
          if (result.ok) {
            version = result.version;
            // As on desktop, a successful write is what makes the page clean; some editors
            // (Monaco) never report clean themselves. Edits made during the write keep it dirty.
            const clean = dirtyMarks === marksAtStart;
            if (clean) cancelAutosave();
            setState({ saving: false, error: null, ...(clean ? { dirty: false } : {}) });
            return;
          }
          setState({ saving: false, conflict: { diskText: result.markdown, diskVersion: result.currentVersion } });
          throw new WikiFileConflictError();
        } catch (error) {
          if (!(error instanceof WikiFileConflictError)) {
            setState({ saving: false, error: error instanceof Error ? error.message : String(error) });
          }
          throw error;
        }
      });
      writing = run;
      return run;
    },

    openHistory: noop,
    registerMenuItems: noop,
    registerEditorAPI: noop,
    setEditorContext: noop,
    setEditorContextItems: noop,
    storage: {
      get: <T>(key: string) => storage.get(key) as T | undefined,
      set: async <T>(key: string, value: T) => {
        storage.set(key, value);
      },
      delete: async (key: string) => {
        storage.delete(key);
      },
      getGlobal: <T>(key: string) => storage.get(`global:${key}`) as T | undefined,
      setGlobal: async <T>(key: string, value: T) => {
        storage.set(`global:${key}`, value);
      },
      deleteGlobal: async (key: string) => {
        storage.delete(`global:${key}`);
      },
    } as EditorHost['storage'],

    getState: () => state,
    subscribeState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    requestSave,
    async resolveConflict(choice) {
      const conflict = state.conflict;
      if (!conflict) return;
      version = conflict.diskVersion;
      setState({ conflict: null });
      if (choice === 'theirs') {
        deliver(conflict.diskText);
        return;
      }
      // The editor saves its current text, now based on the version on disk.
      await requestSave();
    },
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      for (const listener of [...themeListeners]) listener(next);
    },
    dispose() {
      disposed = true;
      cancelAutosave();
      unsubscribeChanges();
      stateListeners.clear();
      fileListeners.clear();
      saveListeners.clear();
      themeListeners.clear();
    },
  };
  return host;
}
