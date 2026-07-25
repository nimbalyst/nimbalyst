/**
 * useEditorLifecycle Hook
 *
 * The single hook for custom editors to integrate with the EditorHost API.
 * Handles all lifecycle concerns: loading, saving, echo detection, dirty state,
 * file change handling, diff mode, theme changes.
 *
 * Content state NEVER lives in this hook. The hook interacts with the editor's
 * state through pull/push callbacks:
 * - applyContent: push new content INTO the editor (on load, external file change)
 * - getCurrentContent: pull current content FROM the editor (on save)
 *
 * This design works for all editor types:
 * - Library-managed (Excalidraw, Three.js): callbacks talk to the library's imperative API
 * - Store-managed (Mindmap, DatamodelLM): callbacks talk to a Zustand store
 * - Read-only (PDF, SQLite): only applyContent, no getCurrentContent
 *
 * @example Library-managed editor (Excalidraw)
 * ```tsx
 * function ExcalidrawEditor({ host }: EditorHostProps) {
 *   const apiRef = useRef<ExcalidrawImperativeAPI>(null);
 *
 *   const { markDirty, isLoading, theme } = useEditorLifecycle(host, {
 *     applyContent: (elements) => apiRef.current?.updateScene({ elements }),
 *     getCurrentContent: () => apiRef.current?.getSceneElements() ?? [],
 *     parse: (raw) => JSON.parse(raw).elements,
 *     serialize: (elements) => JSON.stringify({ elements }),
 *   });
 *
 *   return <Excalidraw ref={apiRef} onChange={(el) => { if (changed(el)) markDirty(); }} />;
 * }
 * ```
 *
 * @example Store-managed editor (Mindmap)
 * ```tsx
 * function MindmapEditor({ host }: EditorHostProps) {
 *   const storeRef = useRef(createMindmapStore());
 *   const store = storeRef.current;
 *
 *   const { markDirty } = useEditorLifecycle(host, {
 *     applyContent: (doc) => store.getState().loadDocument(doc),
 *     getCurrentContent: () => store.getState().document,
 *     parse: parseDocument,
 *     serialize: serializeDocument,
 *   });
 *
 *   return <MindmapCanvas store={store} markDirty={markDirty} />;
 * }
 * ```
 *
 * @example Read-only viewer (PDF)
 * ```tsx
 * function PDFViewer({ host }: EditorHostProps) {
 *   const dataRef = useRef<ArrayBuffer | null>(null);
 *   const [, forceRender] = useReducer((x) => x + 1, 0);
 *
 *   const { isLoading } = useEditorLifecycle(host, {
 *     applyContent: (data) => { dataRef.current = data; forceRender(); },
 *     binary: true,
 *   });
 *
 *   return isLoading ? <Loading /> : <PDFRenderer data={dataRef.current} />;
 * }
 * ```
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { EditorHost, DiffConfig } from './types/editor.js';

// ============================================================================
// Types
// ============================================================================

export interface UseEditorLifecycleOptions<T> {
  /**
   * Push new content into the editor.
   * Called on initial load and on external file changes.
   * This should update the editor's internal state WITHOUT triggering
   * a React re-render of the entire editor tree.
   */
  applyContent: (content: T) => void;

  /**
   * Pull current content from the editor for saving.
   * Omit for read-only editors (PDF viewer, SQLite browser, etc.)
   */
  getCurrentContent?: () => T;

  /**
   * Parse raw file content (string) into the editor's internal format.
   * If omitted, raw string is passed through as-is.
   */
  parse?: (raw: string) => T;

  /**
   * Serialize editor's internal format back to string for saving.
   * If omitted, String(content) is used.
   */
  serialize?: (content: T) => string;

  /**
   * Use loadBinaryContent() instead of loadContent().
   * For binary file formats (PDF, SQLite, images, etc.)
   * When true, parse/serialize are ignored -- applyContent receives the raw
   * ArrayBuffer and getCurrentContent should return an ArrayBuffer.
   */
  binary?: boolean;

  /**
   * Called after initial content is loaded and applied.
   * Use for post-load setup (e.g., fitting viewport to content).
   */
  onLoaded?: () => void;

  /**
   * Called when an external file change is detected and applied.
   * NOT called for echoes from our own saves.
   * Use for editor-specific reactions to external changes (e.g., re-layout).
   */
  onExternalChange?: (content: T) => void;

  /**
   * Custom save handler. When provided, replaces the default
   * getCurrentContent -> serialize -> saveContent flow.
   * Use for editors that require async content extraction (e.g., RevoGrid).
   * The hook still handles dirty state clearing after onSave resolves.
   */
  onSave?: () => Promise<void>;

  /**
   * Custom diff request handler. When provided, replaces the default
   * diff parsing and state management. The editor manages its own diff state.
   * Use for editors with specialized diff rendering (e.g., cell-level CSV diff).
   */
  onDiffRequested?: (config: DiffConfig) => void;

  /**
   * Custom diff cleared handler. When provided, replaces the default
   * diff cleared behavior (reload from disk). Paired with onDiffRequested.
   */
  onDiffCleared?: () => Promise<void>;
}

export interface DiffState<T> {
  /** Content before the AI edit */
  original: T;

  /** Content after the AI edit (what's on disk now) */
  modified: T;

  /** History tag ID for this diff */
  tagId: string;

  /** AI session ID that made the edit */
  sessionId: string;

  /** Accept the AI's changes */
  accept: () => void;

  /** Reject the AI's changes (revert to original) */
  reject: () => void;
}

export interface UseEditorLifecycleResult<T> {
  /**
   * Call when the user makes an edit. Marks the document dirty.
   * No-op for read-only editors (when getCurrentContent is not provided).
   */
  markDirty: () => void;

  /** Whether initial content is still loading. */
  isLoading: boolean;

  /** Error from initial load, or null. */
  error: Error | null;

  /** Current theme (reactive -- updates when user changes theme). */
  theme: string;

  /** Whether the editor has unsaved changes. */
  isDirty: boolean;

  /**
   * Diff state when AI proposes changes. null when not in diff mode.
   * Editors should render a diff view when this is non-null.
   */
  diffState: DiffState<T> | null;

  /** Toggle source mode (switches to Monaco). Only present if host supports it. */
  toggleSourceMode: (() => void) | undefined;

  /** Whether source mode is currently active. */
  isSourceMode: boolean;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useEditorLifecycle<T = string>(
  host: EditorHost,
  options: UseEditorLifecycleOptions<T>
): UseEditorLifecycleResult<T> {
  // -- React state: only for things that SHOULD cause re-renders --
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [theme, setTheme] = useState(host.theme);
  const [diffState, setDiffState] = useState<DiffState<T> | null>(null);
  const [isSourceMode, setIsSourceMode] = useState(
    host.isSourceModeActive?.() ?? false
  );

  // -- Refs: for everything that should NOT cause re-renders --
  // Options ref -- updated every render so callbacks are never stale
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Echo detection: stores the last serialized string we saved
  const lastSavedContentRef = useRef<string>('');

  // Track dirty state in a ref too (for use in callbacks without stale closure)
  const isDirtyRef = useRef(false);

  // ---- Parse / Serialize helpers ----

  const parseContent = useCallback(
    (raw: string): T => {
      const { parse } = optionsRef.current;
      if (parse) return parse(raw);
      return raw as unknown as T;
    },
    [] // stable -- reads from ref
  );

  const serializeContent = useCallback(
    (content: T): string => {
      const { serialize } = optionsRef.current;
      if (serialize) return serialize(content);
      return String(content);
    },
    [] // stable -- reads from ref
  );

  // ---- markDirty ----

  const markDirty = useCallback(() => {
    if (!optionsRef.current.getCurrentContent) return; // read-only
    if (!isDirtyRef.current) {
      isDirtyRef.current = true;
      setIsDirty(true);
      host.setDirty(true);
    }
  }, [host]);

  const clearDirty = useCallback(() => {
    if (isDirtyRef.current) {
      isDirtyRef.current = false;
      setIsDirty(false);
      host.setDirty(false);
    }
  }, [host]);

  // ---- Initial load ----
  // Note: do NOT use a ref-based "already loaded" guard here. React 18
  // StrictMode in dev runs effects setup -> cleanup -> setup. A persistent
  // ref makes the second setup early-return, while the first run's `mounted`
  // closure has already been flipped to false by cleanup, so
  // `setIsLoading(false)` is never called and the editor is stuck on the
  // initial Loading state forever. The dep array (`[host, parseContent]`)
  // already prevents re-loads when nothing has changed; the strict-mode
  // double load is idempotent (same IPC + applyContent) and only happens in
  // dev.
  useEffect(() => {
    let mounted = true;

    const doLoad = async () => {
      try {
        const opts = optionsRef.current;
        if (opts.binary) {
          const data = await host.loadBinaryContent();
          if (!mounted) return;
          opts.applyContent(data as unknown as T);
        } else {
          const raw = await host.loadContent();
          if (!mounted) return;
          const parsed = parseContent(raw);
          lastSavedContentRef.current = raw;
          opts.applyContent(parsed);
        }
        if (!mounted) return;
        setError(null);
        setIsLoading(false);
        optionsRef.current.onLoaded?.();
      } catch (err) {
        if (!mounted) return;
        const loadError =
          err instanceof Error ? err : new Error(String(err));
        setError(loadError);
        setIsLoading(false);
      }
    };

    doLoad();

    return () => {
      mounted = false;
    };
  }, [host, parseContent]);

  // ---- Save handling ----

  useEffect(() => {
    return host.onSaveRequested(async () => {
      const opts = optionsRef.current;

      try {
        if (opts.onSave) {
          // Custom save handler (e.g., async content extraction from RevoGrid)
          await opts.onSave();
        } else {
          if (!opts.getCurrentContent) return; // read-only
          const content = opts.getCurrentContent();
          if (opts.binary) {
            await host.saveContent(content as unknown as ArrayBuffer);
          } else {
            const serialized = serializeContent(content);
            // Update echo detection BEFORE saving so the subsequent onFileChanged is ignored
            lastSavedContentRef.current = serialized;
            await host.saveContent(serialized);
          }
        }
        clearDirty();
      } catch (err) {
        // Save failed -- dirty state remains
      }
    });
  }, [host, serializeContent, clearDirty]);

  // ---- External file changes ----

  useEffect(() => {
    return host.onFileChanged((newRawContent: string) => {
      // Echo detection: ignore if this is our own save echoing back
      if (newRawContent === lastSavedContentRef.current) {
        return;
      }

      const opts = optionsRef.current;
      try {
        const parsed = parseContent(newRawContent);
        lastSavedContentRef.current = newRawContent;
        opts.applyContent(parsed);
        setError(null);
        clearDirty();
        opts.onExternalChange?.(parsed);
      } catch (err) {
        // Failed to parse external change
      }
    });
  }, [host, parseContent, clearDirty]);

  // ---- Theme changes ----

  useEffect(() => {
    return host.onThemeChanged((newTheme: string) => {
      setTheme(newTheme);
    });
  }, [host]);

  // ---- Diff mode ----

  useEffect(() => {
    if (!host.onDiffRequested) return;

    const unsubDiff = host.onDiffRequested((config: DiffConfig) => {
      const opts = optionsRef.current;

      // Custom diff handler -- editor manages its own diff state
      if (opts.onDiffRequested) {
        opts.onDiffRequested(config);
        return;
      }

      let original: T;
      let modified: T;

      try {
        original = opts.binary
          ? (config.originalContent as unknown as T)
          : parseContent(config.originalContent);
        modified = opts.binary
          ? (config.modifiedContent as unknown as T)
          : parseContent(config.modifiedContent);
      } catch (err) {
        return;
      }

      setDiffState({
        original,
        modified,
        tagId: config.tagId,
        sessionId: config.sessionId,
        accept: () => {
          // Accept: apply modified content, report result
          optionsRef.current.applyContent(modified);
          if (!opts.binary) {
            lastSavedContentRef.current =
              serializeContent(modified);
          }
          host.reportDiffResult?.({
            content: opts.binary
              ? ''
              : serializeContent(modified),
            action: 'accept',
          });
          clearDirty();
          setDiffState(null);
        },
        reject: () => {
          // Reject: apply original content, report result
          optionsRef.current.applyContent(original);
          if (!opts.binary) {
            lastSavedContentRef.current =
              serializeContent(original);
          }
          host.reportDiffResult?.({
            content: opts.binary
              ? ''
              : serializeContent(original),
            action: 'reject',
          });
          clearDirty();
          setDiffState(null);
        },
      });
    });

    return unsubDiff;
  }, [host, parseContent, serializeContent, clearDirty]);

  // Handle diff cleared externally (via unified diff header)
  useEffect(() => {
    if (!host.onDiffCleared) return;

    return host.onDiffCleared(async () => {
      const opts = optionsRef.current;

      // Custom diff cleared handler
      if (opts.onDiffCleared) {
        await opts.onDiffCleared();
        return;
      }

      setDiffState(null);
      // Reload content since the file may have changed
      if (!opts.binary) {
        host.loadContent().then((raw: string) => {
          const parsed = parseContent(raw);
          lastSavedContentRef.current = raw;
          optionsRef.current.applyContent(parsed);
          clearDirty();
        });
      }
    });
  }, [host, parseContent, clearDirty]);

  // ---- Source mode ----

  useEffect(() => {
    if (!host.onSourceModeChanged) return;

    return host.onSourceModeChanged((isActive: boolean) => {
      setIsSourceMode(isActive);
    });
  }, [host]);

  const toggleSourceMode = host.toggleSourceMode
    ? useCallback(() => host.toggleSourceMode?.(), [host])
    : undefined;

  // ---- Return ----

  return {
    markDirty,
    isLoading,
    error,
    theme,
    isDirty,
    diffState,
    toggleSourceMode,
    isSourceMode,
  };
}
