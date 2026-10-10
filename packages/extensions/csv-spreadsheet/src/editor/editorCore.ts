/**
 * The mutable state every SpreadsheetEditor feature hook shares.
 *
 * RevoGrid holds the cell data (written only through the command executor) and calls back into templates and event handlers
 * long after the render that created them, so almost everything here is a
 * ref: templates sample them at paint time, handlers read them when they fire,
 * and nothing re-renders the grid by changing one. The object is built once
 * per mount; `hostRef` and `spreadsheetMetaRef` are refreshed every render.
 */

import { useRef, type RefObject } from 'react';
import type { EditorHost } from '@nimbalyst/extension-sdk';
import type { RevoGridElement } from '../revogrid-types';
import type { DiffState, NormalizedSelectionRange, SpreadsheetData } from '../types';
import type { UseSpreadsheetMetadataResult } from '../hooks/useSpreadsheetMetadata';
import type { ColumnFilters } from '../hooks/useColumnFilters';
import type { FormulaBarHandle } from '../components/FormulaBar';
import type { SelectionSnapshot } from '../commands/gridCommandExecutor';
import { createGridKeyState, type GridKeyState } from '../keyboard';
import type { SheetsTextEditor } from '../editors/SheetsTextEditor';
import type { CsvBinding } from '../collab/csvBinding';
import type { CsvMetaBinding, CsvMetaSnapshot } from '../collab/metaBinding';
import { GridHydration } from '../collab/gridHydration';
import type { Rejection } from '../validation/entry';
import { TrackerResolutionStore } from '../cells/trackerResolution';
import { createRowIndexMapping, type RowIndexMapping } from '../filter/rowIndexMapping';
import { EMPTY_FIND_HIGHLIGHT, type FindHighlight } from '../filter/findHighlight';
import {
  FormulaViewState,
  spreadsheetDataToGridSource,
  type GridOperations,
  type GridSourceData,
} from '../utils/gridOperations';
import { DISPLAY_BUFFER_ROWS } from './editorUtils';

export type CellPosition = { row: number; col: number };

export interface EditorCore {
  hostRef: RefObject<EditorHost>;
  spreadsheetMetaRef: RefObject<UseSpreadsheetMetadataResult>;

  editorRef: RefObject<HTMLDivElement | null>;
  gridContainerRef: RefObject<HTMLDivElement | null>;
  revoGridRef: RefObject<RevoGridElement | null>;
  formulaBarRef: RefObject<FormulaBarHandle | null>;
  gridOpsRef: RefObject<GridOperations | null>;
  formulaViewState: FormulaViewState;

  // Selection, always in logical sheet rows.
  selectedCellRef: RefObject<CellPosition | null>;
  selectionRangeRef: RefObject<NormalizedSelectionRange | null>;
  /**
   * Notified after every selection change. The toolbar and status bar read the
   * selection refs through `useSelectionVersion`, so only they re-render on a
   * selection change, not the whole editor.
   */
  selectionListeners: Set<() => void>;
  /**
   * Notified after the row mapping is rebuilt (any write, filter or hidden-row
   * change). Row heights are indexed by visible row, so they re-apply here.
   */
  rowSpaceListeners: Set<() => void>;
  /** Shows a reject-mode validation message; assigned by `useValidationUi`. */
  reportRejectionRef: RefObject<((rejection: Rejection) => void) | null>;
  /** View zoom (1 = 100%). Sizes in metadata are unzoomed; RevoGrid gets them scaled. */
  zoomRef: RefObject<number>;
  /**
   * The key controller's state in logical rows: active cell, anchor/focus
   * corners, edit mode and Tab run. Pointer selections reset it through
   * `updateSelection`; the keyboard writes it directly.
   */
  keyStateRef: RefObject<GridKeyState>;
  /** The open cell editor, so the controller can commit/cancel/insert into it. */
  activeEditorRef: RefObject<SheetsTextEditor | null>;
  /**
   * Text typed to open the editor (and any keys typed before it mounts). The
   * next editor starts with it instead of the cell's value.
   */
  pendingEditTextRef: RefObject<string | null>;
  /**
   * Bumped whenever the controller opens, commits or cancels an edit. An editor
   * remembers the session it opened in: one that mounts after its session was
   * already committed cancels itself, and only the current session's editor
   * may reset the edit mode when it closes.
   */
  editSessionRef: RefObject<number>;
  /** The session a keyboard-requested editor belongs to, until it mounts. */
  openingEditSessionRef: RefObject<number | null>;
  /** Paints a selection after undo/redo/paste; assigned by `useSelection`. */
  restoreSelectionRef: RefObject<((selection: SelectionSnapshot) => void) | null>;
  /** Skips the focus handler during programmatic selection (select-all). */
  skipFocusHandlerRef: RefObject<boolean>;
  /**
   * Set while our own cross-section drag owns the selection. RevoGrid keeps
   * emitting setrange with its clamped, single-section range during the drag;
   * honouring it would snap the selection back at the frozen boundary.
   */
  suppressGridRangeRef: RefObject<boolean>;

  // Grid hydration: render the grid immediately, load data imperatively after
  // mount, so React props never overwrite RevoGrid's internal state.
  pendingDataRef: RefObject<GridSourceData | null>;
  dataLoadedRef: RefObject<boolean>;
  loadedCsvContentRef: RefObject<string>;
  hydration: GridHydration;

  // Collaboration.
  collabBindingRef: RefObject<CsvBinding | null>;
  metaBindingRef: RefObject<CsvMetaBinding | null>;
  /** Guards the publish effect against echoing a snapshot we just received. */
  lastPublishedMetaRef: RefObject<CsvMetaSnapshot | null>;
  collabActiveRef: RefObject<boolean>;

  diffStateRef: RefObject<DiffState | null>;
  /**
   * Editing lock: read-only, a diff under review, or a collab doc that has not
   * hydrated. See `useSpreadsheetLifecycle` for why review is read-only.
   */
  editingLockedRef: RefObject<boolean>;

  /**
   * The visible <-> logical row boundary.
   *
   * RevoGrid addresses rows by *visible* position: with a filter on,
   * `data-rgrow`, its focus/range events, its selection stores and
   * `scrollToRow` all skip the trimmed rows. Selections, formulas and every
   * clipboard consumer are in *logical* sheet rows. Everything in the editor is
   * logical; the only places that speak visible rows are the DOM/event entry
   * points and `paintLogicalRange`, which converts back on the way out.
   */
  rowSpaceRef: RefObject<RowIndexMapping>;
  /** Assigned once `useColumnFilters` runs; read through a ref so the row-view
   * invalidation can be defined before it and stay stable. */
  columnFiltersRef: RefObject<ColumnFilters | null>;

  // View state the column templates sample at paint time. Kept in refs so
  // neither a search keystroke nor a filter rebuilds `columns`.
  findHighlightRef: RefObject<FindHighlight>;
  filteredColumnsRef: RefObject<ReadonlySet<number>>;
  aiFlashRef: RefObject<WeakMap<object, ReadonlySet<string>>>;
  /**
   * Tracker chips resolve through the same sample-at-paint-time contract:
   * templates read the store, the store asks for a repaint when a key resolves.
   */
  trackerStore: TrackerResolutionStore;

  /** Build raw RevoGrid source rows and the derived formula display state. */
  prepareGridData: (data: SpreadsheetData) => GridSourceData;
  /**
   * Repaint the grid after any view state the column templates read changes.
   * Guarded because this can fire before the custom element has hydrated.
   */
  repaintGrid: () => void;
  /** The current named ranges, for formula autocomplete and the name box. */
  getNamedRanges: () => Readonly<Record<string, string>>;
}

const ref = <T,>(current: T): RefObject<T> => ({ current });

export function useEditorCore(
  host: EditorHost,
  spreadsheetMeta: UseSpreadsheetMetadataResult,
  setGridReady: (ready: boolean) => void,
): EditorCore {
  const coreRef = useRef<EditorCore | null>(null);
  if (!coreRef.current) {
    const formulaViewState = new FormulaViewState();
    const revoGridRef = ref<RevoGridElement | null>(null);
    const spreadsheetMetaRef = ref(spreadsheetMeta);
    coreRef.current = {
      hostRef: ref(host),
      spreadsheetMetaRef,
      editorRef: ref<HTMLDivElement | null>(null),
      gridContainerRef: ref<HTMLDivElement | null>(null),
      revoGridRef,
      formulaBarRef: ref<FormulaBarHandle | null>(null),
      gridOpsRef: ref<GridOperations | null>(null),
      formulaViewState,
      selectedCellRef: ref<CellPosition | null>(null),
      selectionRangeRef: ref<NormalizedSelectionRange | null>(null),
      selectionListeners: new Set(),
      rowSpaceListeners: new Set(),
      reportRejectionRef: ref<((rejection: Rejection) => void) | null>(null),
      zoomRef: ref(1),
      restoreSelectionRef: ref<((selection: SelectionSnapshot) => void) | null>(null),
      keyStateRef: ref(createGridKeyState()),
      activeEditorRef: ref<SheetsTextEditor | null>(null),
      pendingEditTextRef: ref<string | null>(null),
      editSessionRef: ref(0),
      openingEditSessionRef: ref<number | null>(null),
      skipFocusHandlerRef: ref(false),
      suppressGridRangeRef: ref(false),
      pendingDataRef: ref<GridSourceData | null>(null),
      dataLoadedRef: ref(false),
      loadedCsvContentRef: ref(''),
      hydration: new GridHydration(setGridReady),
      collabBindingRef: ref<CsvBinding | null>(null),
      metaBindingRef: ref<CsvMetaBinding | null>(null),
      lastPublishedMetaRef: ref<CsvMetaSnapshot | null>(null),
      collabActiveRef: ref(false),
      diffStateRef: ref<DiffState | null>(null),
      editingLockedRef: ref(false),
      rowSpaceRef: ref(createRowIndexMapping({ rowCount: 0 })),
      columnFiltersRef: ref<ColumnFilters | null>(null),
      findHighlightRef: ref<FindHighlight>(EMPTY_FIND_HIGHLIGHT),
      filteredColumnsRef: ref<ReadonlySet<number>>(new Set()),
      aiFlashRef: ref(new WeakMap<object, ReadonlySet<string>>()),
      trackerStore: new TrackerResolutionStore(),
      prepareGridData: (data) => {
        const gridData = spreadsheetDataToGridSource(data, DISPLAY_BUFFER_ROWS);
        formulaViewState.recalculate(data, gridData);
        return gridData;
      },
      repaintGrid: () => {
        const grid = revoGridRef.current;
        if (typeof grid?.refresh === 'function') void grid.refresh('all');
      },
      getNamedRanges: () => spreadsheetMetaRef.current.getMetadata().namedRanges,
    };
  }
  const core = coreRef.current;
  core.hostRef.current = host;
  core.spreadsheetMetaRef.current = spreadsheetMeta;
  return core;
}
