/**
 * TrackerDocumentView - Tracker Mode's content shell.
 *
 * Greg's direction (plan: tracker-document-mode, Layer 2): "i want to stay in
 * tracker mode, but have it switch to 'List mode' with a small list view on the
 * left with the item selected and the tracker content taking up the main
 * screen... and also i want to add a chat panel on the right to chat with my
 * tracker item." So document view is a *presentation* of Tracker Mode, not a
 * second mode: a slim collapsible list pane on the left, the item's content
 * filling the center, and a switchable chat/discussion panel on the right.
 *
 * Both presentations render through this one component on purpose. The detail
 * (and the body editor inside it, with its Y.Doc provider) sits at a single JSX
 * position in both, so switching between them is a repaint, not a remount --
 * two sibling branches would give it a different parent each way and React
 * would tear the editor down (checkbox 24). Everything that differs between the
 * presentations is a class, a width, or a slot that appears beside the detail.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemByIdAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  clampDocumentListPaneWidth,
  clampDocumentRightPanelWidth,
  returnToTrackerTypeListAtom,
  setTrackerModeLayoutAtom,
  trackerModeLayoutAtom,
  DOCUMENT_LIST_PANE_MAX_WIDTH,
  DOCUMENT_LIST_PANE_MIN_WIDTH,
  DOCUMENT_RIGHT_PANEL_MAX_WIDTH,
  DOCUMENT_RIGHT_PANEL_MIN_WIDTH,
} from '../../store/atoms/trackers';
import { useResizeDragShield } from '../../hooks/useResizeDragShield';
import { UnifiedEditorHeaderBar } from '../TabEditor/UnifiedEditorHeaderBar';
import { TrackerDetailPanelResizable } from './TrackerDetailPanelResizable';
import { TrackerDocumentHeaderMeta } from './TrackerDocumentHeaderMeta';
import type { TrackerContentMode } from './TrackerItemDetail';
import { shouldExitDocumentViewOnEscape } from './trackerDocumentEscape';
import { TrackerDocumentPanel } from './TrackerDocumentPanel';
import {
  TrackerDocumentListPaneHeader,
  TrackerDocumentViewHeader,
  type TrackerDocumentBreadcrumb,
} from './TrackerDocumentViewHeader';
import { TrackerDocumentFieldPills } from './TrackerDocumentFieldPills';
import './TrackerDocumentView.css';

/** Breadcrumbs stay readable: deep paths keep their tail, not their root. */
const MAX_BREADCRUMB_SEGMENTS = 3;

interface TrackerDocumentViewProps {
  /** `document` swaps in the focused layout; `item` is the ordinary list + detail panel. */
  presentation: 'item' | 'document';
  /** Item shown as a document. Null in the ordinary presentation. */
  documentItemId: string | null;
  workspacePath?: string;
  /** Banners + toolbar shown above the content row in the ordinary presentation. */
  itemChrome: React.ReactNode;
  /** List region: the full view stack normally, a slim tracker list in document view. */
  listPane: React.ReactNode;
  /** The item detail. Kept at one JSX position across both presentations. */
  detail: React.ReactNode;
  /**
   * How the body is being edited. Drives the document header bar: a
   * collaborative body gets the sync dot and presence, and a file-backed body
   * gets no bar at all because its own `TabEditor` already renders one.
   */
  contentMode?: TrackerContentMode | null;
  /** The body's Lexical editor, for the header bar's TOC and doc actions. */
  bodyEditor?: unknown;
  detailPanelWidth: number;
  onDetailPanelWidthChange: (width: number) => void;
  /** Copy a link that reopens this item in document view (teams only). */
  onCopyDocumentLink?: () => void;
  /** Return to the ordinary tracker list + detail-panel presentation. */
  onCollapseToTracker: () => void;
  /** Open a related item from a relationship field editor. */
  onOpenItem?: (itemId: string) => void;
  onFileOpen?: (filePath: string) => Promise<void> | void;
  onSwitchToAgentMode?: (sessionId?: string) => void;
}

export const TrackerDocumentView: React.FC<TrackerDocumentViewProps> = ({
  presentation,
  documentItemId,
  workspacePath,
  itemChrome,
  listPane,
  detail,
  contentMode,
  bodyEditor,
  detailPanelWidth,
  onDetailPanelWidthChange,
  onCopyDocumentLink,
  onCollapseToTracker,
  onOpenItem,
  onFileOpen,
  onSwitchToAgentMode,
}) => {
  const documentMode = presentation === 'document' && Boolean(documentItemId);
  const item = useAtomValue(trackerItemByIdAtom(documentItemId ?? ''));
  const modeLayout = useAtomValue(trackerModeLayoutAtom);
  const setModeLayout = useSetAtom(setTrackerModeLayoutAtom);
  const returnToTypeList = useSetAtom(returnToTrackerTypeListAtom);

  const listPaneVisible = modeLayout.documentListPaneVisible;
  const listPaneWidth = modeLayout.documentListPaneWidth;
  const rightPanelVisible = modeLayout.documentRightPanelVisible;
  const rightPanelWidth = modeLayout.documentRightPanelWidth;
  const rightPanelMode = modeLayout.documentRightPanelMode;

  const model = useMemo(
    () => globalRegistry.get(item?.primaryType ?? ''),
    [item?.primaryType],
  );

  // Backing file path is workspace-relative (see ElectronDocumentService), so
  // the dirty lookup has to rebuild the absolute path the editor keys on.
  const documentPath = item?.system.documentPath ?? null;
  const absoluteDocumentPath = documentPath
    ? (documentPath.startsWith('/') || !workspacePath
        ? documentPath
        : `${workspacePath.replace(/\/$/, '')}/${documentPath}`)
    : null;
  // DB-only items have no backing file; the empty key is a stable no-op entry.
  const fileDirty = useAtomValue(editorDirtyAtom(makeEditorKey(absoluteDocumentPath ?? '')));

  const breadcrumb = useMemo<TrackerDocumentBreadcrumb>(() => {
    if (documentPath) {
      const all = documentPath.split('/').filter(Boolean);
      const segments = all.length > MAX_BREADCRUMB_SEGMENTS
        ? ['…', ...all.slice(all.length - (MAX_BREADCRUMB_SEGMENTS - 1))]
        : all;
      return {
        kind: 'file',
        segments,
        dirty: Boolean(fileDirty),
        fullPath: absoluteDocumentPath ?? documentPath,
      };
    }
    return {
      kind: 'degraded',
      collection: 'Trackers',
      typeLabel: model?.displayName ?? item?.primaryType ?? 'Item',
    };
  }, [absoluteDocumentPath, documentPath, fileDirty, item?.primaryType, model?.displayName]);

  const handleNavigateToTypeList = useCallback(() => {
    if (!item) return;
    returnToTypeList({ itemId: item.id, trackerType: item.primaryType });
  }, [item, returnToTypeList]);

  // Escape is the keyboard half of "Collapse to tracker". It listens on the
  // bubble phase so anything with its own Escape handling (menus, dialogs,
  // in-place edits) gets it first; see trackerDocumentEscape.ts for the rule.
  useEffect(() => {
    if (!documentMode) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!shouldExitDocumentViewOnEscape(event, document)) return;
      event.preventDefault();
      onCollapseToTracker();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [documentMode, onCollapseToTracker]);

  // Splitters: hand-rolled pointer drag (no splitter libraries in this app),
  // with the shield so a drag over an iframe-backed editor keeps delivering
  // moves. The live width is local state -- writing every move into the layout
  // atom would re-render (and re-persist) the whole tracker view on each frame.
  const [draggingListWidth, setDraggingListWidth] = useState<number | null>(null);
  const listDragRef = useRef({ startX: 0, startWidth: listPaneWidth, latestWidth: listPaneWidth });
  const startListResizeDrag = useResizeDragShield({
    onMove: (event) => {
      const next = clampDocumentListPaneWidth(
        listDragRef.current.startWidth + (event.clientX - listDragRef.current.startX),
      );
      listDragRef.current.latestWidth = next;
      setDraggingListWidth(next);
    },
    onEnd: () => {
      setDraggingListWidth(null);
      setModeLayout({ documentListPaneWidth: listDragRef.current.latestWidth });
    },
  });
  const renderedListPaneWidth = draggingListWidth ?? listPaneWidth;

  const handleListResizePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    listDragRef.current = {
      startX: event.clientX,
      startWidth: listPaneWidth,
      latestWidth: listPaneWidth,
    };
    startListResizeDrag(event);
  }, [listPaneWidth, startListResizeDrag]);

  const [draggingPanelWidth, setDraggingPanelWidth] = useState<number | null>(null);
  const panelDragRef = useRef({ startX: 0, startWidth: rightPanelWidth, latestWidth: rightPanelWidth });
  const startPanelResizeDrag = useResizeDragShield({
    onMove: (event) => {
      // The panel is on the right, so dragging left widens it.
      const next = clampDocumentRightPanelWidth(
        panelDragRef.current.startWidth - (event.clientX - panelDragRef.current.startX),
      );
      panelDragRef.current.latestWidth = next;
      setDraggingPanelWidth(next);
    },
    onEnd: () => {
      setDraggingPanelWidth(null);
      setModeLayout({ documentRightPanelWidth: panelDragRef.current.latestWidth });
    },
  });
  const renderedRightPanelWidth = draggingPanelWidth ?? rightPanelWidth;

  const handlePanelResizePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    panelDragRef.current = {
      startX: event.clientX,
      startWidth: rightPanelWidth,
      latestWidth: rightPanelWidth,
    };
    startPanelResizeDrag(event);
  }, [rightPanelWidth, startPanelResizeDrag]);

  const showRightPanel = documentMode && rightPanelVisible && Boolean(documentItemId);

  // File-backed bodies render through `TabEditor`, which brings its own
  // `UnifiedEditorHeaderBar`; adding a second one would stack two breadcrumbs.
  const showDocumentHeaderBar = documentMode
    && Boolean(documentItemId)
    && contentMode !== 'file-backed';

  // "Copy document link" is the tracker deep link, not a shared-document link,
  // so it rides in as an extra action rather than the bar's built-in Copy link.
  const documentBarActions = useMemo(
    () => (onCopyDocumentLink
      ? [{
          label: 'Copy document link',
          icon: 'link',
          onClick: onCopyDocumentLink,
        }]
      : []),
    [onCopyDocumentLink],
  );

  return (
    <div
      className="tracker-document-view tracker-main-view flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-nim"
      data-testid="tracker-document-view"
      data-presentation={documentMode ? 'document' : 'item'}
    >
      {!documentMode && itemChrome}

      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        {/* List region: the whole view stack normally, a slim list in document view. */}
        {(!documentMode || listPaneVisible) && (
          <div
            className={documentMode
              ? 'tracker-document-view-list-pane flex min-w-0 shrink-0 flex-col overflow-hidden'
              : 'relative min-h-0 min-w-0 flex-1 overflow-hidden'}
            style={documentMode
              ? {
                  width: renderedListPaneWidth,
                  minWidth: DOCUMENT_LIST_PANE_MIN_WIDTH,
                  maxWidth: DOCUMENT_LIST_PANE_MAX_WIDTH,
                }
              : undefined}
            data-testid={documentMode ? 'tracker-document-list-pane' : 'tracker-list-region'}
          >
            {documentMode && (
              <TrackerDocumentListPaneHeader
                collectionLabel="Trackers"
                typeLabel={model?.displayNamePlural ?? model?.displayName ?? item?.primaryType ?? 'Items'}
                onNavigateToTypeList={handleNavigateToTypeList}
              />
            )}
            <div className={documentMode ? 'min-h-0 flex-1 overflow-hidden' : 'contents'}>
              {listPane}
            </div>
          </div>
        )}

        {documentMode && listPaneVisible && (
          <div
            className="tracker-document-view-resize-handle relative z-10 w-1 shrink-0 cursor-col-resize bg-nim-secondary"
            onPointerDown={handleListResizePointerDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize tracker list pane"
            data-testid="tracker-document-list-pane-resize"
          >
            <div className="mx-auto h-full w-0.5 bg-nim-border transition-colors duration-200 hover:bg-nim-accent" />
          </div>
        )}

        {detail && (
          <TrackerDetailPanelResizable
            fill={documentMode}
            width={detailPanelWidth}
            onWidthChange={onDetailPanelWidthChange}
          >
            {documentMode && (
              <TrackerDocumentViewHeader
                issueKey={item ? (item.issueKey || item.id) : null}
                title={item ? getRecordTitle(item) : 'Loading…'}
                fieldPills={documentItemId ? (
                  <TrackerDocumentFieldPills
                    itemId={documentItemId}
                    workspacePath={workspacePath}
                    onOpenItem={onOpenItem}
                  />
                ) : undefined}
                onCollapseToTracker={onCollapseToTracker}
              />
            )}
            {showDocumentHeaderBar && documentItemId && (
              <UnifiedEditorHeaderBar
                filePath={absoluteDocumentPath ?? ''}
                fileName={item ? getRecordTitle(item) : 'Untitled'}
                workspaceId={workspacePath}
                isMarkdown
                lexicalEditor={bodyEditor as never}
                breadcrumbContent={(
                  <TrackerDocumentHeaderMeta
                    itemId={documentItemId}
                    breadcrumb={breadcrumb}
                    title={item ? getRecordTitle(item) : 'Untitled'}
                    showCollabChrome={contentMode === 'collaborative'}
                  />
                )}
                // The document view has its own chat panel, and the remaining
                // file-scoped actions have no meaning for a DB-backed body.
                showAIButton={false}
                showShareLinkButton={false}
                showSharedDocButton={false}
                showHistoryAction={false}
                showCommonFileActions={false}
                showDocumentTypeAction={false}
                extraActionItems={documentBarActions}
              />
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {detail}
            </div>
          </TrackerDetailPanelResizable>
        )}

        {showRightPanel && (
          <div
            className="tracker-document-view-panel-resize-handle relative z-10 w-1 shrink-0 cursor-col-resize bg-nim-secondary"
            onPointerDown={handlePanelResizePointerDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the tracker document panel"
            data-testid="tracker-document-right-panel-resize"
          >
            <div className="mx-auto h-full w-0.5 bg-nim-border transition-colors duration-200 hover:bg-nim-accent" />
          </div>
        )}

        {showRightPanel && documentItemId && (
          <div
            className="tracker-document-view-right-panel min-w-0 shrink-0 overflow-hidden"
            style={{
              width: renderedRightPanelWidth,
              minWidth: DOCUMENT_RIGHT_PANEL_MIN_WIDTH,
              maxWidth: DOCUMENT_RIGHT_PANEL_MAX_WIDTH,
            }}
            data-testid="tracker-document-right-panel"
          >
            <TrackerDocumentPanel
              itemId={documentItemId}
              workspacePath={workspacePath}
              mode={rightPanelMode}
              isActive
              onFileOpen={onFileOpen}
              onSwitchToAgentMode={onSwitchToAgentMode}
            />
          </div>
        )}
      </div>
    </div>
  );
};
