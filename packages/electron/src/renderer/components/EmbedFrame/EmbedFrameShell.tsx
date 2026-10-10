/**
 * The frame every inline embed shares: the chrome (name, Open), the
 * click-to-select shield that keeps wheel and pointer events with the host
 * document until the embed is selected, drag-to-resize handles whose sizes
 * are written back to the node's `attrs`, and an error boundary so a broken
 * embed never takes down the surrounding document.
 *
 * `EmbedFrame` uses the pieces for a local file (which adds edit mode and
 * autosave); `EmbedFrameShell` is the whole frame for a page embed (a Team
 * page's room or a Personal page's stored body) whose editor is passed in.
 */

import React, {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { basename } from 'pathe';
import {
  $getNodeByKey,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { $isEmbeddedFileNode, MaterialSymbol } from '@nimbalyst/runtime';
import { FilePathBreadcrumb } from '../common/FilePathBreadcrumb';

export const DEFAULT_EMBED_HEIGHT_PX = 400;
export const MIN_EMBED_HEIGHT_PX = 120;
export const MIN_EMBED_WIDTH_PX = 200;
const MAX_EMBED_WIDTH_PX = 4000;
const MAX_EMBED_HEIGHT_PX = 4000;

export function parsePx(value: string | undefined, fallback: number, min: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(parsed, min);
}

export function parseOptionalPx(value: string | undefined, min: number): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return null;
  return Math.max(parsed, min);
}

export class EmbedErrorBoundary extends Component<
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

// ---- Resize handles --------------------------------------------------------

export const DIRECTION = {
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

export function useEmbedResize(
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

export interface EmbedFrameShellProps {
  nodeKey: NodeKey;
  attrs: Record<string, string>;
  label: string;
  detached?: boolean;
  /** Shown in the chrome. */
  displayName: string;
  /** The Open button and a double-click: open the embedded page in a tab. */
  onOpen: () => void;
  /** `data-*` markers on the frame root (extension id, kind of page). */
  markers: Record<string, string>;
  loadingText: string;
  children: ReactNode;
}

/** A page embed: chrome, shield, resize handles and error boundary around the editor passed in. */
export const EmbedFrameShell: React.FC<EmbedFrameShellProps> = ({
  nodeKey,
  attrs,
  label,
  detached = false,
  displayName,
  onOpen,
  markers,
  loadingText,
  children,
}) => {
  const [editor] = useLexicalComposerContext();
  const [renderError, setRenderError] = useState<Error | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const heightPx = parsePx(attrs.height, DEFAULT_EMBED_HEIGHT_PX, MIN_EMBED_HEIGHT_PX);
  const widthPx = parseOptionalPx(attrs.width, MIN_EMBED_WIDTH_PX);
  const { isResizing, onResizeStart } = useEmbedResize(editor, nodeKey, frameRef, bodyRef);
  const [nodeSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const isSelected = detached || nodeSelected;

  const handleShieldClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Keep the click from Lexical, which would replace the node selection.
      event.stopPropagation();
      clearSelection();
      setSelected(true);
    },
    [clearSelection, setSelected],
  );
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      onOpen();
    },
    [onOpen],
  );
  // Once selected, interactions inside stay with the embedded editor.
  const keepInside = useCallback(
    (event: React.SyntheticEvent) => {
      if (isSelected) event.stopPropagation();
    },
    [isSelected],
  );

  return (
    <div
      ref={frameRef}
      className={`embed-frame${isResizing ? ' embed-frame--resizing' : ''}${isSelected ? ' embed-frame--selected' : ''}`}
      data-testid="embed-frame"
      data-embed-mode="view"
      data-embed-selected={isSelected ? 'true' : 'false'}
      {...markers}
      style={widthPx ? { width: widthPx, maxWidth: '100%' } : undefined}
    >
      <EmbedChrome
        relativePath={displayName}
        absolutePath={null}
        label={label}
        isReadOnly
        isDirty={false}
        onToggleReadOnly={null}
        onEditClick={onOpen}
      />
      <div
        ref={bodyRef}
        className="embed-frame__body"
        style={{ height: heightPx }}
        onPointerDown={keepInside}
        onMouseDown={keepInside}
        onClick={keepInside}
        onDoubleClick={handleDoubleClick}
      >
        <div
          className="embed-frame__editor-host"
          {...(isSelected ? {} : { inert: true })}
        >
          <EmbedErrorBoundary onError={setRenderError} absolutePath={null}>
            <React.Suspense fallback={<div className="embed-frame__loading">{loadingText}</div>}>
              {children}
            </React.Suspense>
          </EmbedErrorBoundary>
        </div>
        {!isSelected && (
          <div
            className="embed-frame__shield"
            data-testid="embed-frame-shield"
            onClick={handleShieldClick}
            onDoubleClick={handleDoubleClick}
            aria-hidden="true"
          />
        )}
      </div>
      {renderError && (
        <div className="embed-frame__error-footer" data-testid="embed-frame-error-footer">
          {renderError.message}
        </div>
      )}
      <EmbedResizeHandles onResizeStart={onResizeStart} hidden={detached} />
    </div>
  );
};

/** A page embed that cannot be shown: its name, Open, and why. */
export const EmbedUnresolved: React.FC<{ displayName: string; label: string; src: string; error: string; onOpen: () => void; testId: string }> = ({
  displayName,
  label,
  src,
  error,
  onOpen,
  testId,
}) => (
  <div className="embed-frame embed-frame--error" data-testid={testId}>
    <EmbedChrome
      relativePath={displayName}
      absolutePath={null}
      label={label}
      isReadOnly
      isDirty={false}
      onToggleReadOnly={null}
      onEditClick={onOpen}
    />
    <div className="embed-frame__body embed-frame__body--placeholder">
      <MaterialSymbol icon="link_off" size={28} />
      <p>{error}</p>
      <code>{src}</code>
    </div>
  </div>
);

/** Resize handles. Pointer-events: auto on each keeps them clickable above the embedded editor canvas (z:0). */
export const EmbedResizeHandles: React.FC<{
  onResizeStart: (event: React.PointerEvent, direction: number) => void;
  hidden: boolean;
}> = ({ onResizeStart, hidden }) => (
  <>
    <div
      className="embed-frame__resizer embed-frame__resizer--e"
      data-testid="embed-frame-resize-e"
      onPointerDown={(event) => onResizeStart(event, DIRECTION.east)}
      hidden={hidden}
    />
    <div
      className="embed-frame__resizer embed-frame__resizer--s"
      data-testid="embed-frame-resize-s"
      onPointerDown={(event) => onResizeStart(event, DIRECTION.south)}
      hidden={hidden}
    />
    <div
      className="embed-frame__resizer embed-frame__resizer--se"
      data-testid="embed-frame-resize-se"
      onPointerDown={(event) => onResizeStart(event, DIRECTION.south | DIRECTION.east)}
      hidden={hidden}
    />
  </>
);

export interface EmbedChromeProps {
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

export const EmbedChrome: React.FC<EmbedChromeProps> = ({
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
