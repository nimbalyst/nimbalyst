/**
 * EmbedFrame -- the renderer-side implementation of an inline embedded
 * editor. Mounted by Lexical's `EmbeddedFileNode.decorate()` via the
 * runtime's `embedPluginCallbacks.renderEmbed` slot.
 *
 * Responsibilities:
 *   - Resolve the markdown link target against the host doc's directory.
 *   - Look up which extension can render the file in `customEditorRegistry`.
 *   - Build a read-only `EditorHost` for the embedded file (with the
 *     workspace file watcher wired through).
 *   - Render the chrome (file path + Edit button) above the extension
 *     component, with an error boundary so a broken embed never takes
 *     down the surrounding Lexical doc.
 *   - Provide drag-to-resize handles on the south, east, and southeast
 *     edges (matching the image-resize UX). New dimensions are written
 *     back to the `EmbeddedFileNode`'s `attrs.height` / `attrs.width` so
 *     they round-trip through markdown as link-title attributes.
 *
 * Phase 1: no IntersectionObserver gating, no mount cap. Always mount the
 * extension; performance gating lands in Phase 3.
 */

import React, {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isAbsolute, join, basename } from 'pathe';
import {
  $getNodeByKey,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import type { EmbedFrameProps } from '@nimbalyst/runtime';
import {
  $isEmbeddedFileNode,
  useDocumentPath,
  MaterialSymbol,
} from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';

import { customEditorRegistry } from '../CustomEditors/registry';
import { FilePathBreadcrumb } from '../common/FilePathBreadcrumb';
import { fileChangedOnDiskAtomFamily } from '../../store/atoms/fileWatch';
import { useTheme } from '../../hooks/useTheme';
import { createEmbeddedFileHost } from './createEmbeddedFileHost';

import './EmbedFrame.css';

const DEFAULT_EMBED_HEIGHT_PX = 400;
const MIN_EMBED_HEIGHT_PX = 120;
const MIN_EMBED_WIDTH_PX = 200;
const MAX_EMBED_WIDTH_PX = 4000;
const MAX_EMBED_HEIGHT_PX = 4000;

function parsePx(value: string | undefined, fallback: number, min: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(parsed, min);
}

function parseOptionalPx(value: string | undefined, min: number): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return Math.max(parsed, min);
}

function resolveEmbedPath(rawSrc: string, hostDocDir: string | null): string | null {
  if (!rawSrc) return null;
  // Bare URLs (http://, mailto:, etc.) never embed -- they shouldn't have
  // gotten past `isEmbeddableUrl` in the first place, but be defensive.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawSrc) && !/^file:\/\//i.test(rawSrc)) {
    return null;
  }
  // Strip a leading `file://` if present so we get a filesystem path.
  const stripped = rawSrc.replace(/^file:\/\//i, '');
  if (isAbsolute(stripped)) return stripped;

  // Convention:
  //   * `./foo.x` or `../foo.x`  -> resolve relative to the host doc dir.
  //   * Anything else (e.g. `nimbalyst-local/foo.excalidraw`, what the @
  //     picker inserts) -> resolve relative to the workspace root.
  // Users who want host-doc-relative paths use the `./` / `../` prefix.
  const explicitlyDocRelative = stripped.startsWith('./') || stripped.startsWith('../');
  const workspacePath = (window as unknown as { __workspacePath?: string }).__workspacePath;

  if (explicitlyDocRelative) {
    return hostDocDir ? join(hostDocDir, stripped) : null;
  }
  if (workspacePath) return join(workspacePath, stripped);
  if (hostDocDir) return join(hostDocDir, stripped);
  return null;
}

class EmbedErrorBoundary extends Component<
  { children: ReactNode; onError: (err: Error) => void; absolutePath: string | null },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
    console.error(
      '[EmbedFrame] Extension crashed inside embed for',
      this.props.absolutePath,
      error,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="embed-frame__error" data-testid="embed-frame-error">
          <MaterialSymbol icon="error" size={20} />
          <span>
            Failed to render embed:&nbsp;
            {this.state.error?.message ?? 'unknown error'}
          </span>
        </div>
      );
    }
    return this.props.children;
  }
}

function openFileInTab(absolutePath: string): void {
  const workspacePath = (window as unknown as { __workspacePath?: string }).__workspacePath;
  if (!workspacePath) {
    console.error('[EmbedFrame] __workspacePath not set -- cannot open embed in a tab');
    return;
  }
  const api = (window as unknown as {
    electronAPI?: {
      invoke?: (channel: string, payload: unknown) => Promise<unknown>;
    };
  }).electronAPI;
  if (!api?.invoke) return;
  api
    .invoke('workspace:open-file', { workspacePath, filePath: absolutePath })
    .catch((error: unknown) => {
      console.error('[EmbedFrame] Failed to open embed in tab:', error);
    });
}

type ReadFileResult =
  | null
  | { success: true; content: string; isBinary: boolean; detectedEncoding?: string }
  | { success: false; error: string };

async function readFileFromDisk(absolutePath: string): Promise<string> {
  const api = (window as unknown as {
    electronAPI?: {
      readFileContent?: (
        path: string,
        opts?: { binary?: boolean },
      ) => Promise<ReadFileResult>;
    };
  }).electronAPI;
  if (!api?.readFileContent) {
    throw new Error('readFileContent IPC not available');
  }
  const result = await api.readFileContent(absolutePath);
  // null = file missing on disk (or virtual:// stub).
  if (!result) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  if (result.success === false) {
    throw new Error(result.error || `Failed to read ${absolutePath}`);
  }
  return result.content;
}

async function writeFileToDisk(
  absolutePath: string,
  content: string | ArrayBuffer,
): Promise<void> {
  const api = (window as unknown as {
    electronAPI?: {
      saveFile?: (
        content: string,
        filePath: string,
        lastKnownContent?: string,
      ) => Promise<unknown>;
    };
  }).electronAPI;
  if (!api?.saveFile) throw new Error('saveFile IPC not available');
  const text =
    typeof content === 'string'
      ? content
      : new TextDecoder().decode(content);
  await api.saveFile(text, absolutePath);
}

function workspaceRelativePath(absolutePath: string): string {
  const workspacePath = (window as unknown as { __workspacePath?: string }).__workspacePath;
  if (!workspacePath) return absolutePath;
  if (absolutePath.startsWith(workspacePath)) {
    const rest = absolutePath.slice(workspacePath.length);
    return rest.replace(/^[/\\]/, '');
  }
  return absolutePath;
}

// ---- Resize handles --------------------------------------------------------

const DIRECTION = {
  east: 1 << 0,
  south: 1 << 1,
} as const;

interface ResizeStart {
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  direction: number;
}

function useEmbedResize(
  editor: LexicalEditor,
  nodeKey: NodeKey,
  frameRef: React.RefObject<HTMLDivElement | null>,
  bodyRef: React.RefObject<HTMLDivElement | null>,
): {
  isResizing: boolean;
  onResizeStart: (event: React.PointerEvent, direction: number) => void;
} {
  const [isResizing, setIsResizing] = useState(false);
  const startRef = useRef<ResizeStart | null>(null);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const start = startRef.current;
    const frame = frameRef.current;
    const body = bodyRef.current;
    if (!start || !frame || !body) return;

    if (start.direction & DIRECTION.east) {
      const dx = event.clientX - start.startX;
      const next = Math.min(
        MAX_EMBED_WIDTH_PX,
        Math.max(MIN_EMBED_WIDTH_PX, start.startWidth + dx),
      );
      frame.style.width = `${Math.round(next)}px`;
    }
    if (start.direction & DIRECTION.south) {
      const dy = event.clientY - start.startY;
      const next = Math.min(
        MAX_EMBED_HEIGHT_PX,
        Math.max(MIN_EMBED_HEIGHT_PX, start.startHeight + dy),
      );
      body.style.height = `${Math.round(next)}px`;
    }
  }, [bodyRef, frameRef]);

  const onPointerUp = useCallback(() => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('-webkit-user-select');

    const frame = frameRef.current;
    const body = bodyRef.current;
    const start = startRef.current;
    startRef.current = null;
    setIsResizing(false);

    if (!frame || !body || !start) return;

    // Read back the final pixel sizes the browser actually laid out (which
    // will have been clamped by our move handler) and write them into the
    // Lexical node so the change persists to markdown.
    const widthPx = Math.round(frame.getBoundingClientRect().width);
    const heightPx = Math.round(body.getBoundingClientRect().height);

    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isEmbeddedFileNode(node)) return;
      const nextAttrs = { ...node.getAttrs() };
      if (start.direction & DIRECTION.east) {
        nextAttrs.width = String(widthPx);
      }
      if (start.direction & DIRECTION.south) {
        nextAttrs.height = String(heightPx);
      }
      node.setAttrs(nextAttrs);
    });
  }, [bodyRef, editor, frameRef, nodeKey, onPointerMove]);

  const onResizeStart = useCallback((event: React.PointerEvent, direction: number) => {
    const frame = frameRef.current;
    const body = bodyRef.current;
    if (!frame || !body) return;
    event.preventDefault();
    event.stopPropagation();

    startRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: frame.getBoundingClientRect().width,
      startHeight: body.getBoundingClientRect().height,
      direction,
    };
    setIsResizing(true);

    // Match the cursor of the active handle so the cursor doesn't snap back
    // to text-select when the pointer drifts off the handle mid-drag.
    const cursor =
      direction === (DIRECTION.south | DIRECTION.east)
        ? 'nwse-resize'
        : direction === DIRECTION.east
          ? 'ew-resize'
          : 'ns-resize';
    document.body.style.setProperty('cursor', cursor, 'important');
    document.body.style.setProperty('-webkit-user-select', 'none', 'important');

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }, [bodyRef, frameRef, onPointerMove, onPointerUp]);

  useEffect(() => {
    return () => {
      // Defensive cleanup in case the embed unmounts mid-drag.
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  return { isResizing, onResizeStart };
}

// ----------------------------------------------------------------------------

export const EmbedFrame: React.FC<EmbedFrameProps> = (props) => {
  const { src, label, attrs, nodeKey } = props;
  const { documentDir } = useDocumentPath();
  const { theme } = useTheme();
  const [editor] = useLexicalComposerContext();
  const [renderError, setRenderError] = useState<Error | null>(null);

  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const absolutePath = useMemo(
    () => resolveEmbedPath(src, documentDir),
    [src, documentDir],
  );

  const registration = useMemo(() => {
    if (!absolutePath) return undefined;
    return customEditorRegistry.findRegistrationForFile(absolutePath);
  }, [absolutePath]);

  const heightPx = parsePx(attrs.height, DEFAULT_EMBED_HEIGHT_PX, MIN_EMBED_HEIGHT_PX);
  const widthPx = parseOptionalPx(attrs.width, MIN_EMBED_WIDTH_PX);

  const { isResizing, onResizeStart } = useEmbedResize(editor, nodeKey, frameRef, bodyRef);

  // Node-selection gate. Until the user clicks (and selects) this embed,
  // a shield sits over the embedded editor swallowing pointer events --
  // so scroll/wheel bubbles past the embed to the host editor's scroller
  // instead of being eaten by Excalidraw's zoom handler or ReactFlow's
  // pan handler. Once selected, the shield drops out and the embedded
  // editor takes over directly. Clicking elsewhere creates a
  // RangeSelection, `isSelected` flips back to false, and the shield
  // reinstates itself.
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);

  const handleShieldClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Don't let the click also bubble out to Lexical -- otherwise the
      // editor's own click handler creates a RangeSelection on whatever
      // text is "nearest" and clears the node-selection we're about to
      // set, leaving the shield up.
      event.stopPropagation();
      clearSelection();
      setSelected(true);
    },
    [clearSelection, setSelected],
  );

  const handleShieldDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Mirrors the body's double-click: open the embedded file in a
      // new tab. We have to handle it here because the shield is on top
      // of the body's onDoubleClick target while it's mounted.
      event.stopPropagation();
      if (absolutePath) {
        openFileInTab(absolutePath);
      }
    },
    [absolutePath],
  );

  const themeRef = useRef(theme);
  themeRef.current = theme;
  const themeListeners = useRef(new Set<(theme: string) => void>());
  useEffect(() => {
    themeListeners.current.forEach((cb) => cb(theme));
  }, [theme]);

  // View mode is the default. Toggling to edit mode flips host.readOnly
  // so extensions that respect it (e.g. Excalidraw via viewModeEnabled)
  // light up their editing UI. In edit mode, the host wires real
  // saveContent + setDirty + onSaveRequested so user edits autosave back
  // to the embedded file.
  const [isReadOnly, setIsReadOnly] = useState(true);
  const isReadOnlyRef = useRef(isReadOnly);
  isReadOnlyRef.current = isReadOnly;
  const readOnlyListeners = useRef(new Set<(readOnly: boolean) => void>());
  useEffect(() => {
    readOnlyListeners.current.forEach((cb) => cb(isReadOnly));
  }, [isReadOnly]);

  // ---- Save / dirty state for edit mode --------------------------------
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const saveRequestListeners = useRef(new Set<() => void>());
  // Content of our most recent save -- used to dedupe the file-watcher
  // event that fires when our own save hits disk (we don't want to round-
  // trip the bytes back through the extension's onFileChanged callback).
  const lastSavedContentRef = useRef<string | null>(null);

  const toggleReadOnly = useCallback(() => {
    setIsReadOnly((prev) => {
      const next = !prev;
      // Switching back to view mode while dirty -- ask the extension to
      // flush before we drop the editing UI. Saves are async; the user
      // will see the dot clear as the write completes.
      if (next && isDirtyRef.current) {
        saveRequestListeners.current.forEach((cb) => {
          try { cb(); } catch (err) { console.error(err); }
        });
      }
      return next;
    });
  }, []);

  // Autosave: while in edit mode and dirty, ask the extension to save on
  // a 2s cadence. The extension's `onSaveRequested` handler is what
  // actually pulls the content and calls `host.saveContent`.
  useEffect(() => {
    if (isReadOnly) return;
    const interval = setInterval(() => {
      if (!isDirtyRef.current) return;
      saveRequestListeners.current.forEach((cb) => {
        try { cb(); } catch (err) { console.error('[EmbedFrame] save request failed', err); }
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [isReadOnly]);

  const host = useMemo(() => {
    if (!absolutePath) return null;
    return createEmbeddedFileHost({
      embedPath: absolutePath,
      workspaceId: (window as unknown as { __workspacePath?: string }).__workspacePath,
      getTheme: () => themeRef.current,
      subscribeToThemeChanges(cb) {
        themeListeners.current.add(cb);
        return () => {
          themeListeners.current.delete(cb);
        };
      },
      subscribeToFileChanges(path, cb) {
        const atom = fileChangedOnDiskAtomFamily(path);
        return store.sub(atom, () => {
          readFileFromDisk(path)
            .then((content) => {
              // Save-echo dedup: the file-watcher fires immediately after
              // our own write. Skip the callback if the content matches
              // what we just saved so we don't bounce the bytes through
              // the extension's onFileChanged and reset its scroll/view.
              if (
                lastSavedContentRef.current !== null &&
                content === lastSavedContentRef.current
              ) {
                return;
              }
              cb(content);
            })
            .catch((err) => {
              console.error(
                '[EmbedFrame] Failed to reload embed after file-change for',
                path,
                err,
              );
            });
        });
      },
      readFile: readFileFromDisk,
      async saveFile(path, content) {
        const text =
          typeof content === 'string'
            ? content
            : new TextDecoder().decode(content);
        lastSavedContentRef.current = text;
        await writeFileToDisk(path, text);
        // Optimistically clear dirty -- the extension will mark dirty
        // again on the next user edit. If the write threw, the dirty
        // state stays (we don't catch here).
        isDirtyRef.current = false;
        setIsDirty(false);
      },
      getReadOnly: () => isReadOnlyRef.current,
      subscribeToReadOnlyChanges(cb) {
        readOnlyListeners.current.add(cb);
        return () => {
          readOnlyListeners.current.delete(cb);
        };
      },
      onDirtyChange(next) {
        if (next === isDirtyRef.current) return;
        isDirtyRef.current = next;
        setIsDirty(next);
      },
      subscribeToSaveRequests(cb) {
        saveRequestListeners.current.add(cb);
        return () => {
          saveRequestListeners.current.delete(cb);
        };
      },
    });
    // Host is stable per absolutePath. External file changes (and read-only
    // toggles) flow to the mounted extension via `host.onFileChanged(...)`
    // / `host.onReadOnlyChanged(...)` rather than re-mount, which preserves
    // the extension's view-state (pan / zoom / scroll).
  }, [absolutePath]);

  const handleEditClick = useCallback(() => {
    if (!absolutePath) return;
    openFileInTab(absolutePath);
  }, [absolutePath]);

  const handleBodyDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Stop propagation so the double-click isn't interpreted as text
      // selection by the host Lexical editor.
      event.stopPropagation();
      handleEditClick();
    },
    [handleEditClick],
  );

  const handleSelectedEmbedPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isSelected) return;
      // Once the embed is selected, interactions inside its body should
      // stay within the embedded editor. If this bubbles to Lexical, the
      // host editor converts the NodeSelection back to a RangeSelection,
      // reinstates the shield, and Monaco immediately loses focus.
      event.stopPropagation();
    },
    [isSelected],
  );

  const handleSelectedEmbedMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelected) return;
      event.stopPropagation();
    },
    [isSelected],
  );

  const handleSelectedEmbedClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelected) return;
      event.stopPropagation();
    },
    [isSelected],
  );

  const frameStyle = useMemo<React.CSSProperties>(
    () => (widthPx ? { width: widthPx, maxWidth: '100%' } : {}),
    [widthPx],
  );

  // ---- Failure / missing-capability placeholders -----------------------
  if (!absolutePath) {
    return (
      <div className="embed-frame embed-frame--error" data-testid="embed-frame-unresolved">
        <EmbedChrome
          relativePath={src}
          absolutePath={null}
          label={label}
          isReadOnly={isReadOnly}
          isDirty={false}
          onToggleReadOnly={null}
          onEditClick={() => {}}
        />
        <div className="embed-frame__body embed-frame__body--placeholder">
          <MaterialSymbol icon="link_off" size={28} />
          <p>Could not resolve embed path</p>
          <code>{src}</code>
        </div>
      </div>
    );
  }

  if (!registration) {
    return (
      <div className="embed-frame embed-frame--no-extension" data-testid="embed-frame-no-extension">
        <EmbedChrome
          relativePath={workspaceRelativePath(absolutePath)}
          absolutePath={absolutePath}
          label={label}
          isReadOnly={isReadOnly}
          isDirty={false}
          onToggleReadOnly={null}
          onEditClick={handleEditClick}
        />
        <div className="embed-frame__body embed-frame__body--placeholder">
          <MaterialSymbol icon="extension_off" size={28} />
          <p>
            No installed extension can render <code>{basename(absolutePath)}</code> inline.
          </p>
        </div>
      </div>
    );
  }

  const ExtensionComponent = registration.component;

  return (
    <div
      ref={frameRef}
      className={`embed-frame${isResizing ? ' embed-frame--resizing' : ''}${isReadOnly ? '' : ' embed-frame--edit-mode'}${isDirty ? ' embed-frame--dirty' : ''}${isSelected ? ' embed-frame--selected' : ''}`}
      data-testid="embed-frame"
      data-embed-extension={registration.extensionId}
      data-embed-mode={isReadOnly ? 'view' : 'edit'}
      data-embed-dirty={isDirty ? 'true' : 'false'}
      data-embed-selected={isSelected ? 'true' : 'false'}
      style={frameStyle}
    >
      <EmbedChrome
        relativePath={workspaceRelativePath(absolutePath)}
        absolutePath={absolutePath}
        label={label}
        isReadOnly={isReadOnly}
        isDirty={isDirty}
        onToggleReadOnly={toggleReadOnly}
        onEditClick={handleEditClick}
      />
      <div
        ref={bodyRef}
        className="embed-frame__body"
        style={{ height: heightPx }}
        onPointerDown={handleSelectedEmbedPointerDown}
        onMouseDown={handleSelectedEmbedMouseDown}
        onClick={handleSelectedEmbedClick}
        onDoubleClick={handleBodyDoubleClick}
      >
        {/* Editor wrapper establishes its own stacking context (via
         * `isolation: isolate`) so the embedded editor's internal z-
         * indexes (Excalidraw goes up to 999999 for popovers) can't
         * escape and paint over the click-to-select shield.
         *
         * When the embed is not the active NodeSelection the wrapper
         * also gets the HTML `inert` attribute. `inert` blocks pointer
         * AND wheel events for the entire subtree -- so two-finger
         * trackpad scrolls bubble past the embed to the host editor's
         * scroller instead of being eaten by Excalidraw's onWheel
         * (which we can't reach via z-index because Excalidraw's
         * canvas/UI elements may sit above the shield in stacking
         * order). Spread-pattern keeps it off the React 18 prop list
         * entirely when selected.
         */}
        <div
          className="embed-frame__editor-host"
          {...(isSelected ? {} : { inert: '' as unknown as boolean })}
        >
          <EmbedErrorBoundary onError={setRenderError} absolutePath={absolutePath}>
            {host && (
              <React.Suspense
                fallback={<div className="embed-frame__loading">Loading embed...</div>}
              >
                <ExtensionComponent host={host} />
              </React.Suspense>
            )}
          </EmbedErrorBoundary>
        </div>
        {!isSelected && (
          <div
            className="embed-frame__shield"
            data-testid="embed-frame-shield"
            onClick={handleShieldClick}
            onDoubleClick={handleShieldDoubleClick}
            aria-hidden="true"
          />
        )}
      </div>
      {renderError && (
        <div className="embed-frame__error-footer" data-testid="embed-frame-error-footer">
          {renderError.message}
        </div>
      )}
      {/* Resize handles. Pointer-events: auto on each handle keeps them
       * clickable above the embedded editor canvas (which is z:0). */}
      <div
        className="embed-frame__resizer embed-frame__resizer--e"
        data-testid="embed-frame-resize-e"
        onPointerDown={(e) => onResizeStart(e, DIRECTION.east)}
      />
      <div
        className="embed-frame__resizer embed-frame__resizer--s"
        data-testid="embed-frame-resize-s"
        onPointerDown={(e) => onResizeStart(e, DIRECTION.south)}
      />
      <div
        className="embed-frame__resizer embed-frame__resizer--se"
        data-testid="embed-frame-resize-se"
        onPointerDown={(e) => onResizeStart(e, DIRECTION.south | DIRECTION.east)}
      />
    </div>
  );
};

interface EmbedChromeProps {
  relativePath: string;
  absolutePath: string | null;
  label: string;
  isReadOnly: boolean;
  isDirty: boolean;
  /**
   * Called when the user clicks the in-place mode toggle. `null` hides
   * the toggle entirely (placeholders / unresolved embeds don't need it).
   */
  onToggleReadOnly: (() => void) | null;
  onEditClick: () => void;
}

const EmbedChrome: React.FC<EmbedChromeProps> = ({
  relativePath,
  absolutePath,
  label,
  isReadOnly,
  isDirty,
  onToggleReadOnly,
  onEditClick,
}) => {
  // Show the label if it differs from the bare file name, so users can
  // tell at a glance why the link said one thing and the embed shows
  // another file.
  const showLabel = !!label && label !== basename(relativePath);
  const workspacePath = (window as unknown as { __workspacePath?: string }).__workspacePath ?? null;
  return (
    <div className="embed-frame__chrome" data-testid="embed-frame-chrome">
      {absolutePath ? (
        <FilePathBreadcrumb
          filePath={absolutePath}
          workspacePath={workspacePath}
          className="embed-frame__breadcrumb flex-1"
        />
      ) : (
        <span className="embed-frame__path" title={relativePath}>
          {relativePath}
        </span>
      )}
      {isDirty && (
        <span
          className="embed-frame__dirty-dot"
          title="Unsaved changes -- autosaving"
          data-testid="embed-frame-dirty-dot"
          aria-label="Unsaved changes"
        />
      )}
      {showLabel && (
        <span className="embed-frame__label" title={`Link label: ${label}`}>
          {label}
        </span>
      )}
      <span className="embed-frame__spacer" />
      {onToggleReadOnly && (
        <button
          type="button"
          className="embed-frame__mode-btn"
          onClick={onToggleReadOnly}
          title={
            isReadOnly
              ? 'Edit in place (autosaves to the embedded file)'
              : 'Done editing -- back to view mode'
          }
          data-testid="embed-frame-mode-toggle"
          data-mode={isReadOnly ? 'view' : 'edit'}
          aria-pressed={!isReadOnly}
        >
          <MaterialSymbol icon={isReadOnly ? 'visibility' : 'edit'} size={14} />
        </button>
      )}
      <button
        type="button"
        className="embed-frame__edit-btn"
        onClick={onEditClick}
        title="Open file in a new tab"
        data-testid="embed-frame-edit"
      >
        <MaterialSymbol icon="open_in_new" size={14} />
        Open
      </button>
    </div>
  );
};
