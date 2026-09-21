/**
 * `.canvas` editor: binds an `EditorHost` to the host-agnostic CanvasSurface.
 *
 * The editor owns its content, per EDITOR_STATE.md -- the document lives here,
 * not in a parent, and the host only learns about it through `setDirty` and
 * `saveContent`.
 *
 * A file that fails to parse puts this editor into an error state and blocks
 * saving outright. Falling back to an empty board would be the shape of bug
 * that overwrites a user's work with nothing the first time autosave fires.
 *
 * Where a user left the board is kept in `host.storage`, which is the workspace-
 * scoped per-user store every custom editor already has -- not in the document,
 * which is shared, and not in `localStorage`, which the renderer may not use.
 * A collaborative host currently stubs `storage` out, so a shared board opens on
 * its saved home view rather than on your last position; that is a gap in the
 * collab host, not a reason to put view state back into the shared board.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as Y from 'yjs';

import type { EditorHostProps } from '../extensions/editorHost';
import { useCollaborativeEditor } from '../extensions/useCollaborativeEditor';

import {
  createEmptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
  type CanvasDocument,
  type CanvasViewport,
} from './CanvasDocument';
import {
  CanvasBinding,
  type CanvasAwarenessEntry,
  type CanvasAwarenessPatch,
} from './canvasBinding';
import { canvasCollabCodec } from './canvasCollabCodec';
import {
  canvasPanelStateKey,
  type CanvasPanelState,
} from './canvasPanelState';
import { canvasWorkingSetRegistry } from './canvasPresence';
import { CanvasSurface } from './CanvasSurface';
import { useCanvasComments } from './useCanvasComments';

const EMPTY_AWARENESS: ReadonlyMap<number, CanvasAwarenessEntry> = new Map();

/**
 * Stands in while the board is still loading. The comment wiring runs before
 * the first projection lands -- hooks cannot wait on it -- and resolving every
 * anchor against an empty board for one render is correct: nothing is attached
 * yet because nothing has been read yet.
 */
const EMPTY_CANVAS_DOCUMENT: CanvasDocument = Object.freeze({
  nodes: [],
  edges: [],
}) as CanvasDocument;

/** Wheel zoom ends many times a second; the store write does not need to. */
const VIEWPORT_PERSIST_DEBOUNCE_MS = 400;

function isViewport(value: unknown): value is CanvasViewport {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    Number.isFinite(candidate.zoom)
  );
}

export function CanvasEditor({ host }: EditorHostProps): ReactElement {
  const collaborative = host.collaboration !== undefined;
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(host.readOnly === true);

  // The exact projection the mounted surface used to compute its next edit.
  // A Y transaction may project a newer object while React still paints the
  // previous one for a tick, so this advances only after commit.
  const renderedDocumentRef = useRef<CanvasDocument | null>(document);
  useLayoutEffect(() => {
    renderedDocumentRef.current = document;
  }, [document]);
  const bindingRef = useRef<CanvasBinding | null>(null);
  const localYDocRef = useRef<Y.Doc | null>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const lastSavedTextRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const errorRef = useRef<string | null>(error);
  errorRef.current = error;

  // Per-user view state, keyed by board. Read once at mount -- not "once we get
  // a value": a host with no real storage returns undefined every time, and
  // retrying on each render would put an IPC-shaped call on a surface that
  // re-renders on every frame of a drag.
  const viewportKey = `canvas.viewport:${host.filePath}`;
  const storedViewport = useRef<CanvasViewport | null | undefined>(undefined);
  if (storedViewport.current === undefined) {
    const stored: unknown = host.storage.get(viewportKey);
    storedViewport.current = isViewport(stored) ? stored : null;
  }
  // Chrome preferences ride the same seam, read once at mount for the same
  // reason. Unlike the viewport these are not validated here: the surface's own
  // `canvasPanelStateFrom` merges whatever comes back against the defaults, so
  // there is one place that knows what a preference is worth.
  const panelKey = canvasPanelStateKey(host.filePath);
  const storedPanelState = useRef<unknown>(undefined);
  const hasReadPanelState = useRef(false);
  if (!hasReadPanelState.current) {
    hasReadPanelState.current = true;
    storedPanelState.current = host.storage.get(panelKey);
  }

  const handlePanelStateChange = useCallback(
    (next: CanvasPanelState) => {
      // Not debounced: a toggle is a click, not a wheel. Fire and forget, as
      // with the viewport -- a lost preference is not worth a dialog.
      void host.storage.set(panelKey, { ...next });
    },
    [host, panelKey]
  );

  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (viewportTimerRef.current !== null) {
        clearTimeout(viewportTimerRef.current);
      }
    },
    []
  );

  const parseLocalSource = useCallback((text: string): string => {
    if (text.trim().length === 0) {
      return serializeCanvasDocument(createEmptyCanvasDocument());
    }
    parseCanvasDocument(text);
    return text;
  }, []);

  const projectDocument = useCallback((next: CanvasDocument) => {
    setDocument(next);
    setError(null);
  }, []);

  const reportParseError = useCallback((cause: unknown) => {
    setDocument(null);
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const markLocalDirty = useCallback(() => {
    if (collaborative || dirtyRef.current) return;
    dirtyRef.current = true;
    host.setDirty(true);
  }, [collaborative, host]);

  const [awarenessEntries, setAwarenessEntries] =
    useState<ReadonlyMap<number, CanvasAwarenessEntry>>(EMPTY_AWARENESS);
  const [localClientId, setLocalClientId] = useState<number | null>(null);

  useCollaborativeEditor(host, {
    codec: canvasCollabCodec,
    bind: ({ yDoc, awareness }) => {
      const binding = new CanvasBinding(yDoc, {
        awareness,
        enableUndoManager: true,
        onDocumentChange: projectDocument,
        onAwarenessChange: setAwarenessEntries,
      });
      bindingRef.current = binding;
      setLocalClientId(binding.getLocalClientId());
      // The board may already be carrying claims: a session can declare while
      // the document is closed, and binding can complete long after mount.
      const held = canvasWorkingSetRegistry.getBoard(host.filePath);
      if (held.length > 0) binding.setAwareness({ agents: held });
      return {
        destroy: () => {
          if (bindingRef.current === binding) bindingRef.current = null;
          binding.destroy();
          setAwarenessEntries(EMPTY_AWARENESS);
          setLocalClientId(null);
        },
      };
    },
  });

  /**
   * Agent sessions declaring a working set on *this* board.
   *
   * The registry is filled from outside React -- an MCP tool call arriving over
   * IPC -- and is keyed by the board the host names, so a claim made while the
   * board is closed is held and published the moment it opens rather than
   * failing because the user happened to be looking elsewhere.
   */
  const localAgents = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        canvasWorkingSetRegistry.subscribe(host.filePath, onChange),
      [host.filePath]
    ),
    useCallback(
      () => canvasWorkingSetRegistry.getBoard(host.filePath),
      [host.filePath]
    )
  );

  // Awareness is the only channel this takes: a claim is ephemeral presence and
  // must never reach `nodes` / `edges` / `meta`, where it would be saved to the
  // file and land in undo history.
  useEffect(() => {
    if (!collaborative) return;
    bindingRef.current?.setAwareness({
      agents: localAgents.length > 0 ? localAgents : null,
    });
  }, [collaborative, localAgents]);

  /**
   * A private board has no room and therefore no awareness, but it can still
   * have a session working it -- that is the common case, not the exception.
   * Synthesising a local-only entry is what lets the halo mean the same thing
   * on a file nobody has shared. Client id 0 is never a real awareness id, and
   * marking it local keeps the layer from drawing a cursor for a participant
   * that has no pointer.
   */
  const presenceEntries = useMemo<ReadonlyMap<number, CanvasAwarenessEntry>>(
    () =>
      collaborative
        ? awarenessEntries
        : localAgents.length === 0
        ? EMPTY_AWARENESS
        : new Map([[0, { clientId: 0, agents: localAgents }]]),
    [collaborative, awarenessEntries, localAgents]
  );
  const presenceClientId = collaborative ? localClientId : 0;

  // A local board uses the same binding and Y.Doc shape as a shared board.
  // The only difference is ownership: this editor creates/destroys the Y.Doc
  // and exports it to disk, while a collaborative host owns the transported
  // Y.Doc. React remains a projection in both modes.
  useEffect(() => {
    if (collaborative) return;
    let cancelled = false;
    let localYDoc: Y.Doc | null = null;
    let localBinding: CanvasBinding | null = null;

    void host
      .loadContent()
      .then((text) => {
        const source = parseLocalSource(text);
        if (cancelled) return;
        localYDoc = new Y.Doc();
        canvasCollabCodec.seedFromFile(localYDoc, source);
        localBinding = new CanvasBinding(localYDoc, {
          enableUndoManager: true,
          onDocumentChange: projectDocument,
        });
        localYDocRef.current = localYDoc;
        bindingRef.current = localBinding;
        lastSavedTextRef.current = text;
        dirtyRef.current = false;
      })
      .catch((cause: unknown) => {
        if (!cancelled) reportParseError(cause);
      });

    return () => {
      cancelled = true;
      if (bindingRef.current === localBinding) bindingRef.current = null;
      if (localYDocRef.current === localYDoc) localYDocRef.current = null;
      localBinding?.destroy();
      localYDoc?.destroy();
    };
  }, [
    host,
    collaborative,
    parseLocalSource,
    projectDocument,
    reportParseError,
  ]);

  const applyExternalLocalContent = useCallback(
    (text: string) => {
      try {
        const source = parseLocalSource(text);
        const yDoc = localYDocRef.current;
        if (!yDoc) return;
        canvasCollabCodec.applyFromFile(yDoc, source);
        lastSavedTextRef.current = text;
        dirtyRef.current = false;
        setError(null);
      } catch (cause) {
        reportParseError(cause);
      }
    },
    [parseLocalSource, reportParseError]
  );

  useEffect(() => {
    if (collaborative) return;
    return host.onFileChanged((text) => {
      // Our own write comes back through the watcher; and while the board has
      // unsaved edits the user's in-progress work wins over the disk copy.
      if (text === lastSavedTextRef.current || dirtyRef.current) return;
      applyExternalLocalContent(text);
    });
  }, [host, applyExternalLocalContent, collaborative]);

  useEffect(() => {
    if (collaborative) return;
    host.registerEditorAPI({
      // Explicit host reload, unlike watcher updates, may replace a dirty
      // buffer. Return the actual saved representation for host verification.
      reloadContent(text: string): string {
        const source = parseLocalSource(text);
        const yDoc = localYDocRef.current;
        if (!yDoc) throw new Error('Canvas is not ready to reload');
        canvasCollabCodec.applyFromFile(yDoc, source);
        const exported = canvasCollabCodec.exportToFile(yDoc);
        const buffer = typeof exported === 'string' ? exported : new TextDecoder().decode(exported);
        lastSavedTextRef.current = text;
        dirtyRef.current = false;
        setError(null);
        return buffer;
      },
    });
    return () => host.registerEditorAPI(null);
  }, [host, collaborative, parseLocalSource]);

  useEffect(() => {
    if (collaborative) return;
    return host.onSaveRequested(async () => {
      const yDoc = localYDocRef.current;
      if (!yDoc || errorRef.current !== null) return;
      const exported = canvasCollabCodec.exportToFile(yDoc);
      const text =
        typeof exported === 'string'
          ? exported
          : new TextDecoder('utf-8').decode(exported);
      lastSavedTextRef.current = text;
      await host.saveContent(text);
      dirtyRef.current = false;
      host.setDirty(false);
    });
  }, [host, collaborative]);

  useEffect(() => {
    setReadOnly(host.readOnly === true);
    return host.onReadOnlyChanged?.((next) => setReadOnly(next));
  }, [host]);

  const handleDocumentChange = useCallback(
    (next: CanvasDocument) => {
      const binding = bindingRef.current;
      const rendered = renderedDocumentRef.current;
      if (!binding || !rendered) return;
      binding.applyLocalDocument(rendered, next);
      markLocalDirty();
    },
    [markLocalDirty]
  );

  const handleEditBoundary = useCallback(() => {
    bindingRef.current?.stopCapturing();
  }, []);

  const handleViewportChange = useCallback(
    (viewport: CanvasViewport) => {
      if (viewportTimerRef.current !== null) {
        clearTimeout(viewportTimerRef.current);
      }
      viewportTimerRef.current = setTimeout(() => {
        viewportTimerRef.current = null;
        // Fire and forget: losing the last view of a board to a failed write is
        // not worth surfacing, and there is nothing useful to do about it.
        void host.storage.set(viewportKey, {
          x: viewport.x,
          y: viewport.y,
          zoom: viewport.zoom,
        });
      }, VIEWPORT_PERSIST_DEBOUNCE_MS);
    },
    [host, viewportKey]
  );

  const handleAwarenessChange = useCallback((patch: CanvasAwarenessPatch) => {
    bindingRef.current?.setAwareness(patch);
  }, []);

  /**
   * Comments hang off the board's own room, so a private `.canvas` file has
   * none and the affordances disappear rather than writing somewhere local that
   * nobody else would ever see.
   *
   * A collaborative tab's `filePath` *is* the `collab://` URI the comment tools
   * address (see `openCollabDocument`), and that is the only identifier an
   * `@agent` prompt can hand a session so its reply lands in the right thread.
   */
  const documentUri = host.filePath.startsWith('collab://')
    ? host.filePath
    : null;
  const comments = useCanvasComments({
    service: host.collaboration?.comments ?? null,
    document: document ?? EMPTY_CANVAS_DOCUMENT,
    user: host.collaboration?.user ?? null,
    boardName: host.fileName || host.filePath,
    documentUri,
  });

  const handleUndoKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const binding = bindingRef.current;
      if (!binding || readOnly) return;
      const key = event.key.toLowerCase();
      const accel = event.metaKey || event.ctrlKey;
      // Ctrl+Y is redo everywhere Windows conventions apply, and costs nothing
      // to honour on the other platforms.
      const redo =
        (accel && key === 'z' && event.shiftKey) ||
        (event.ctrlKey && !event.metaKey && key === 'y');
      const undo = accel && key === 'z' && !event.shiftKey;
      if (!undo && !redo) return;

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable ||
          target.closest('.canvas-card-host') !== null)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const changed = redo ? binding.redo() : binding.undo();
      if (changed) markLocalDirty();
    },
    [markLocalDirty, readOnly]
  );

  const focusBoardForUndo = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        !target ||
        target.closest('.canvas-card-host') !== null ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }
      editorRootRef.current?.focus({ preventScroll: true });
    },
    []
  );

  if (error !== null) {
    return (
      <div className="canvas-editor canvas-editor--error">
        <div className="canvas-editor__error-title">
          This canvas could not be opened
        </div>
        <div className="canvas-editor__error-detail select-text">{error}</div>
        <div className="canvas-editor__error-note">
          The file has not been modified. Open it in source mode to inspect it.
        </div>
      </div>
    );
  }

  if (document === null) {
    return <div className="canvas-editor canvas-editor--loading" />;
  }

  return (
    <div
      className="canvas-editor"
      data-canvas-collaborative={collaborative ? 'true' : 'false'}
      ref={editorRootRef}
      tabIndex={-1}
      onKeyDownCapture={handleUndoKey}
      onPointerDownCapture={focusBoardForUndo}
    >
      <CanvasSurface
        document={document}
        collaborative={collaborative}
        onDocumentChange={handleDocumentChange}
        onEditBoundary={handleEditBoundary}
        onViewportChange={handleViewportChange}
        initialViewport={storedViewport.current ?? null}
        initialPanelState={storedPanelState.current}
        onPanelStateChange={handlePanelStateChange}
        onAwarenessChange={collaborative ? handleAwarenessChange : undefined}
        awarenessEntries={presenceEntries}
        localClientId={presenceClientId}
        comments={comments}
        readOnly={readOnly}
      />
    </div>
  );
}
