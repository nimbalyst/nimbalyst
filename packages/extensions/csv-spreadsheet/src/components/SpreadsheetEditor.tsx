/**
 * SpreadsheetEditor Component
 *
 * The main editor component for CSV files. Integrates with Nimbalyst's
 * custom editor system and provides a spreadsheet-like editing experience.
 *
 * Architecture:
 * - RevoGrid holds the cell data; every write is a SheetCommand run by the
 *   command executor (commands/), which also owns undo/redo
 * - useSpreadsheetMetadata holds headers, frozen cols, formats, styles
 * - gridOperations is the operation API the UI and agent tools call
 *
 * This file is the grid shell. Each feature lives in a hook under `../editor/`
 * and shares mutable state through `EditorCore`. Hook call order is
 * deliberate: it is the order their effects run on mount.
 */

import { useEffect, useState, useMemo } from 'react';
import { RevoGrid } from '@revolist/react-datagrid';
import type { EditorHostProps } from '../types';
import { useSpreadsheetMetadata } from '../hooks/useSpreadsheetMetadata';
import { CellStyleIndex } from '../cells/cellStyles';
import { TrackerCellResolvers } from '../cells/TrackerCellResolvers';
import { CollabPresenceOverlay } from './CollabPresenceOverlay';
import { FormulaBar } from './FormulaBar';
import { FormulaReferenceOverlay } from './FormulaReferenceOverlay';
import { keyStateFromSelection } from '../keyboard';
import { ContextMenu } from './ContextMenu';
import { FindBar } from './FindBar';
import { ColumnFilterDropdown } from './ColumnFilterDropdown';
import { useEditorCore } from '../editor/editorCore';
import { DISPLAY_BUFFER_COLS } from '../editor/editorUtils';
import { generateColumns } from '../editor/gridColumns';
import { useSheetChrome } from '../editor/useSheetChrome';
import { pinnedRowCount } from '../sheetMeta/formatting';
import { useRowView } from '../editor/useRowView';
import { useSpreadsheetLifecycle } from '../editor/useSpreadsheetLifecycle';
import { useCollabWiring, useMetaPublish } from '../editor/useCollabWiring';
import { useGridOperationsSetup } from '../editor/useGridOperationsSetup';
import { useSelection } from '../editor/useSelection';
import { useFormatting, SpreadsheetFormatDialogs } from '../editor/formatting';
import { useFindAndFilters } from '../editor/useFindAndFilters';
import { useCellLinks } from '../editor/useCellLinks';
import { useEditorKeyDown } from '../editor/useEditorKeyDown';
import { useSpreadsheetContextMenu } from '../editor/useSpreadsheetContextMenu';
import { useHeaderMouse } from '../editor/useHeaderMouse';
import { useGridEditEvents } from '../editor/useGridEditEvents';
import { useGridKeyboard } from '../editor/useGridKeyboard';
import { useGridClipboard } from '../editor/useGridClipboard';
import { ShortcutHelpDialog } from './ShortcutHelpDialog';
import { LinkDialogHost } from './LinkDialog';
import { SheetToolbar } from './toolbar/SheetToolbar';
import { SheetStatusBar } from './SheetStatusBar';
import { SheetFormattingLayer } from './SheetFormattingLayer';
import { ConditionalFormatPanel } from './ConditionalFormatPanel';
import type { DiffState } from '../types';

export function SpreadsheetEditor({ host }: EditorHostProps) {
  const { filePath, isActive } = host;

  // Reactive read-only state. In read-only mode (inline embeds, share
  // viewer) we hide the formula-bar toolbar, suppress the right-click
  // editing context menu, and pass `readonly` through to RevoGrid so cells
  // can't be edited. Selection, scrolling, and copy still work.
  const [readOnly, setReadOnly] = useState<boolean>(host.readOnly ?? false);
  useEffect(() => {
    setReadOnly(host.readOnly ?? false);
    return host.onReadOnlyChanged?.((next) => {
      setReadOnly(next);
    });
  }, [host]);

  // Metadata hook (manages headers, frozen cols, formats - NOT cell data)
  const spreadsheetMeta = useSpreadsheetMetadata(filePath, {
    onDirtyChange: host.setDirty,
  });
  const { metadata } = spreadsheetMeta;
  const displayColumnCount = metadata.columnCount + DISPLAY_BUFFER_COLS;
  const { frozenColumnCount, columnFormats, columnWidths } = metadata;

  const [gridReady, setGridReady] = useState(false);
  const core = useEditorCore(host, spreadsheetMeta, setGridReady);
  const { hydration, editorRef, gridContainerRef, formulaBarRef, trackerStore } = core;
  useEffect(() => {
    hydration.check();
  }, [hydration, metadata]);

  // Header rows and frozen rows are both pinned at the top of the grid.
  const pinnedRows = pinnedRowCount(metadata);
  const rowView = useRowView(core, pinnedRows);

  // Diff mode state for AI edit review. Review is read-only; the grid's own
  // cell editor is gated by RevoGrid's `readonly` prop, and `editingLockedRef`
  // covers everything that writes without going through it.
  const [diffState, setDiffState] = useState<DiffState | null>(null);
  core.diffStateRef.current = diffState;
  const isDiffActive = diffState?.isActive ?? false;
  core.editingLockedRef.current = readOnly || isDiffActive || (!!host.collaboration && !gridReady);

  const { isLoading, error: loadError, theme } = useSpreadsheetLifecycle(
    host, core, rowView.applyGridSource, setDiffState,
  );

  const collab = useCollabWiring(host, core, rowView.applyGridSource);
  const { isCollabActive, remotePresences, presenceRepaintTick, schedulePresenceRepaint, editors } = collab;

  // Rebuilt only when the styles themselves change; the index memoizes lookups
  // internally so a repaint does not rescan every range for every cell.
  const cellStyleIndex = useMemo(
    () => new CellStyleIndex(metadata.cellStyles),
    [metadata.cellStyles],
  );

  const gridEnabled = isActive && !isLoading && !loadError;
  const chrome = useSheetChrome(core, metadata, rowView, gridEnabled);
  const { paint, zoom } = chrome;

  // Memoized column definitions. RevoGrid's built-in themes are not used: they
  // hardcode colors that override the CSS mapping --revo-* to --nim-*.
  const columns = useMemo(
    () => generateColumns({
      columnCount: displayColumnCount,
      formulaViewState: core.formulaViewState,
      frozenColumnCount,
      columnWidths,
      hiddenCols: metadata.hiddenCols,
      diffState,
      findHighlightRef: core.findHighlightRef,
      filteredColumnsRef: core.filteredColumnsRef,
      aiFlashRef: core.aiFlashRef,
      trackerStore,
      cellStyleIndex,
      ...paint,
      zoom,
    }),
    [displayColumnCount, frozenColumnCount, columnWidths, metadata.hiddenCols, diffState, trackerStore,
     cellStyleIndex, paint, zoom, core]
  );

  useGridOperationsSetup(core, { isLoading, filePath, invalidateRowView: rowView.invalidateRowView });

  const selection = useSelection(host, core, rowView, {
    publishLocalSelection: collab.publishLocalSelection,
    frozenColumnCount,
    dragEnabled: isActive && !isLoading && !loadError,
  });

  const formatting = useFormatting(core);

  const { columnFilters, find, filterDropdown, setFilterDropdown, filterValues, openFilterDropdown } =
    useFindAndFilters(host, core, rowView, selection, { headerRowCount: pinnedRows, frozenColumnCount, displayColumnCount });

  const trackerKeys = useCellLinks(core, isLoading, loadError);
  useMetaPublish(core, metadata);

  const handleKeyDown = useEditorKeyDown(core, isActive, selection);
  const { contextMenu, contextMenuItems, handleContextMenu, handleCloseContextMenu } =
    useSpreadsheetContextMenu(core, spreadsheetMeta, rowView, selection, formatting);
  const handleHeaderMouseDown = useHeaderMouse(rowView, selection, { frozenColumnCount, openFilterDropdown });
  const { handleBeforeEdit, handleBeforeRangeEdit, handleBeforeAutofill, handleBeforeEditStart, handleColumnResize,
    handleFormulaChange } = useGridEditEvents(core, rowView, selection, collab, gridEnabled);
  const keyboard = useGridKeyboard(core, rowView, selection, { enabled: gridEnabled, displayColumnCount });
  useGridClipboard(core, { enabled: gridEnabled, pasteValuesOnlyRef: keyboard.pasteValuesOnlyRef });
  const { handleFocusCell, handleSetRange } = selection;

  // Render loading state
  if (isLoading) {
    return (
      <div className="spreadsheet-editor flex flex-col h-full w-full bg-nim text-nim overflow-hidden" data-theme={theme}>
        <div className="flex items-center justify-center h-full text-nim-muted">
          Loading spreadsheet...
        </div>
      </div>
    );
  }

  // Render error state
  if (loadError) {
    return (
      <div className="spreadsheet-editor flex flex-col h-full w-full bg-nim text-nim overflow-hidden" data-theme={theme}>
        <div className="p-5 text-nim bg-nim">
          <h3 className="text-nim">Error Loading Spreadsheet</h3>
          <p className="text-nim-muted">{loadError.message}</p>
        </div>
      </div>
    );
  }

  const locked = isDiffActive || (!!host.collaboration && !gridReady);
  return (
    <div
      ref={editorRef}
      className="spreadsheet-editor flex flex-col h-full w-full bg-nim text-nim overflow-hidden"
      data-theme={theme}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      style={{ '--csv-zoom': zoom } as React.CSSProperties}
    >
      {!readOnly && (
        <SheetToolbar
          core={core}
          metadata={metadata}
          actions={chrome.actions}
          disabled={locked}
          onFilter={openFilterDropdown}
          onInsertFunction={chrome.insertFunction}
          onOpenConditional={() => chrome.setConditionalOpen((open) => !open)}
          onOpenValidation={() => chrome.setValidationOpen(true)}
          onOpenNamedRanges={() => chrome.setNamedRangesOpen(true)}
          trailing={host.supportsSourceMode && (
            <button
              className="px-2 py-1 text-[12px] font-medium bg-nim-tertiary border border-nim rounded text-nim-muted cursor-pointer whitespace-nowrap hover:bg-nim-hover hover:text-nim"
              onClick={() => host.toggleSourceMode?.()}
              title="View raw CSV source"
            >
              View Source
            </button>
          )}
        />
      )}
      {!readOnly && (
        <div className="flex items-center gap-2 bg-nim-secondary border-b border-nim">
          <FormulaBar
            ref={formulaBarRef}
            onChange={handleFormulaChange}
            readOnly={locked}
            onNavigate={(range) => selection.selectFromKeyboard(keyStateFromSelection({ row: range.startRow, col: range.startCol }, range, 'none'))}
            getNamedRanges={core.getNamedRanges}
          />
        </div>
      )}
      {!readOnly && find.isOpen && <FindBar find={find} readOnly={locked} />}
      <TrackerCellResolvers keys={trackerKeys} store={trackerStore} />
      <div className="flex flex-1 min-h-0">
      <div
        ref={gridContainerRef}
        className="flex-1 overflow-hidden relative"
        tabIndex={0}
        {...(!isActive ? { inert: true } : {})}
        data-is-active={isActive}
        // Cmd/Ctrl+K is a link and Cmd/Ctrl+B bold here, not the app's Agent-mode
        // switch and left-pane toggle (see the host's `isShortcutClaimedByTarget`).
        data-claims-shortcuts="mod+k mod+b"
        onContextMenu={handleContextMenu}
        onMouseDown={handleHeaderMouseDown}
      >
        <RevoGrid
          ref={rowView.attachGrid}
          columns={columns}
          rowHeaders={chrome.rowHeaders}
          // Denser than RevoGrid's 27px default. Its theme hardcodes the
          // matching `line-height`, so the stylesheets restate it (scaled by zoom).
          rowSize={Math.round(24 * zoom)}
          resize={true}
          autoSizeColumn={false}
          range={true}
          applyOnClose={true}
          editors={editors}
          rowClass="_rowClass"
          readonly={readOnly || diffState?.isActive || (isCollabActive && !gridReady)}
          onBeforeedit={handleBeforeEdit}
          onBeforerangeedit={handleBeforeRangeEdit}
          onBeforeautofill={handleBeforeAutofill}
          onAfterfocus={handleFocusCell}
          // @ts-expect-error onSetrange exists but not in React type defs
          onSetrange={handleSetRange}
          onAftercolumnresize={handleColumnResize}
          onBeforeeditstart={handleBeforeEditStart}
          onViewportscroll={schedulePresenceRepaint}
        />
        {isCollabActive && remotePresences.length > 0 && (
          <CollabPresenceOverlay
            presences={remotePresences}
            containerRef={gridContainerRef}
            headerRowCount={pinnedRows}
            repaintKey={presenceRepaintTick}
          />
        )}
        {!readOnly && <FormulaReferenceOverlay core={core} enabled={gridEnabled && !isDiffActive} />}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={handleCloseContextMenu}
          />
        )}
        {filterDropdown && (
          <ColumnFilterDropdown
            key={filterDropdown.columnIndex}
            columnIndex={filterDropdown.columnIndex}
            anchor={filterDropdown.anchor}
            distinctValues={filterValues}
            currentFilter={columnFilters.filters.get(filterDropdown.columnIndex)}
            columnFormat={columnFormats[filterDropdown.columnIndex]}
            onApply={(filter) => { void columnFilters.setColumnFilter(filterDropdown.columnIndex, filter); }}
            onClose={() => setFilterDropdown(null)}
          />
        )}
      </div>
      {!readOnly && chrome.conditionalOpen && (
        <ConditionalFormatPanel
          formats={metadata.conditionalFormats}
          selectionKey={chrome.selectionKey}
          onChange={chrome.setConditionalFormats}
          onClose={() => chrome.setConditionalOpen(false)}
        />
      )}
      </div>
      <SheetStatusBar core={core} paint={paint} zoom={zoom} onZoom={chrome.setZoom} />
      <SheetFormattingLayer chrome={chrome} core={core} namedRanges={metadata.namedRanges} />
      <SpreadsheetFormatDialogs
        core={core}
        formatting={formatting}
        spreadsheetMeta={spreadsheetMeta}
        cellStyleIndex={cellStyleIndex}
      />
      <ShortcutHelpDialog isOpen={keyboard.shortcutSheetOpen} onClose={() => keyboard.setShortcutSheetOpen(false)} />
      <LinkDialogHost core={core} target={keyboard.linkTarget} onClose={() => keyboard.setLinkTarget(null)} />
    </div>
  );
}
