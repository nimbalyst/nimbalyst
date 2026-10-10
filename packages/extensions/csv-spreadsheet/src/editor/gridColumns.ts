/**
 * RevoGrid column definitions for the spreadsheet: header template with the
 * filter funnel, the formatted cell template, and per-cell classes (alignment,
 * negatives, styles, conditional formats, wrap, borders, validation, find, AI
 * flash, diff).
 *
 * Every per-cell lookup is by *logical* row, resolved from the row model
 * (`LogicalRowIndex`), never from RevoGrid's `rowIndex`: that is a visible
 * index, which names the wrong row once a filter or hidden rows trim the view.
 */

import type { RefObject } from 'react';
import type { ColumnRegular } from '@revolist/react-datagrid';
import type { CellStyle, ColumnFormat, DiffState } from '../types';
import type { FormulaViewState } from '../utils/gridOperations';
import { generateColumnHeaders } from '../utils/csvParser';
import { getCellDiffClass, getCellPreviousValue } from '../utils/diffCompute';
import {
  getDefaultAlignmentForType,
  isNegativeFormattedValue,
  isNumericCellValue,
  shownValue,
  usesRedNegatives,
} from '../utils/formatters';
import { renderCheckboxCell, renderListCell, renderTrackerCell, renderValueCell } from '../cells/cellRendering';
import type { TrackerResolutionStore } from '../cells/trackerResolution';
import { CellStyleIndex, styleClassNames, styleInlineCss } from '../cells/cellStyles';
import type { SheetDecorations } from '../cells/sheetDecorations';
import type { ConditionalPainter, LogicalRowIndex } from '../cells/paintContext';
import { isCheckboxChecked, validateCellValue } from '../validation/validate';
import { EMPTY_FIND_HIGHLIGHT, type FindHighlight } from '../filter/findHighlight';

const ALIGNMENT_CLASSES = {
  left: 'cell-align-left',
  center: 'cell-align-center',
  right: 'cell-align-right',
} as const;

export const DEFAULT_COLUMN_WIDTH = 120;
/**
 * A hidden column keeps a sliver of width: RevoGrid treats a zero size as
 * "use the default", and the sliver doubles as the hidden-column marker.
 */
export const HIDDEN_COLUMN_WIDTH = 3;

/**
 * Get CSS class for column alignment.
 *
 * An explicit `align` on the format wins; otherwise the column's type picks the
 * conventional side (numbers and dates right, checkboxes centered, text left).
 */
function getAlignmentClass(format: ColumnFormat | undefined): string {
  if (!format) return '';
  if (format.align) return ALIGNMENT_CLASSES[format.align];
  const fallback = getDefaultAlignmentForType(format.type);
  return fallback ? ALIGNMENT_CLASSES[fallback] : '';
}

export interface ColumnOptions {
  columnCount: number;
  formulaViewState: FormulaViewState;
  frozenColumnCount?: number;
  columnWidths?: Record<number, number>;
  hiddenCols?: readonly number[];
  diffState?: DiffState | null;
  /**
   * Read through refs, never through props: the columns memo must not be
   * rebuilt on every keystroke of a find query or every filter change, so both
   * are mutable state the templates sample at paint time (the same trick
   * `formulaViewState` uses). Callers repaint with `grid.refresh('all')`.
   */
  findHighlightRef?: RefObject<FindHighlight>;
  filteredColumnsRef?: RefObject<ReadonlySet<number>>;
  aiFlashRef?: RefObject<WeakMap<object, ReadonlySet<string>>>;
  trackerStore?: TrackerResolutionStore | null;
  cellStyleIndex?: CellStyleIndex;
  decorations: SheetDecorations;
  rows: LogicalRowIndex;
  conditional: ConditionalPainter;
  /** View zoom; column widths are stored unzoomed. */
  zoom?: number;
}

/** The style a cell paints with: its range style, with a conditional format layered on top. */
function paintedStyle(base: CellStyle | null, conditional: ReturnType<ConditionalPainter['styleAt']>): CellStyle | null {
  if (!conditional) return base;
  return { ...(base ?? {}), ...conditional } as CellStyle;
}

/**
 * Generate column definitions for RevoGrid
 */
export function generateColumns(options: ColumnOptions): ColumnRegular[] {
  const {
    columnCount, formulaViewState, frozenColumnCount = 0, columnWidths = {}, diffState = null,
    findHighlightRef = { current: EMPTY_FIND_HIGHLIGHT }, filteredColumnsRef = { current: new Set() },
    aiFlashRef = { current: new WeakMap() }, trackerStore = null, cellStyleIndex = new CellStyleIndex({}),
    decorations, rows, conditional,
  } = options;
  const hidden = new Set(options.hiddenCols ?? []);

  return generateColumnHeaders(columnCount).map((letter, index) => {
    const isHidden = hidden.has(index);
    const width = isHidden ? HIDDEN_COLUMN_WIDTH : Math.round((columnWidths[index] ?? DEFAULT_COLUMN_WIDTH) * (options.zoom ?? 1));
    const displayOf = (model: Record<string, unknown>) => formulaViewState.getDisplayValue(model, letter) ?? model[letter];

    return {
      prop: letter,
      name: letter,
      size: width,
      editor: 'sheets',
      ...(isHidden ? { columnProperties: () => ({ class: { 'csv-col-hidden': true } }) } : {}),
      ...(index < frozenColumnCount ? { pin: 'colPinStart' as const } : {}),
      // The funnel is a plain marked-up span rather than a React node; the
      // editor picks its clicks up through the header mousedown delegation it
      // already runs, and anchors the dropdown to this element.
      columnTemplate: (h, props) => (isHidden ? h('span', { class: 'csv-header-hidden', title: `Column ${letter} is hidden` }, '') : h('span', { class: 'csv-header-cell' }, [
        h('span', { class: 'csv-header-label' }, props.name ?? ''),
        h('span', {
          class: filteredColumnsRef.current?.has(index)
            ? 'csv-filter-affordance csv-filter-affordance-active'
            : 'csv-filter-affordance',
          title: 'Filter column',
        }, '▼'),
      ])),
      // RevoGrid's editor reads the raw model value, while this template can
      // render the separately-derived formula result. Number formatting is
      // applied last so formulas and literals follow the same display rules.
      cellTemplate: (h, props) => {
        if (isHidden) return h('span', {}, '');
        const model = props.model as Record<string, unknown> | undefined;
        const raw = model?.[letter];
        const displayValue = model ? displayOf(model) : raw;
        const value = typeof displayValue === 'string' || typeof displayValue === 'number' ? displayValue : null;
        const row = model ? rows.rowOf(model) : undefined;
        const format = row === undefined ? options.decorations.formatAt(-1, index) : decorations.formatAt(row, index);

        const rule = row === undefined ? null : decorations.validationAt(row, index);
        if (rule?.kind === 'list' && model?._rowClass !== 'header-row') {
          return renderListCell(h, value === null ? '' : String(value), rule.options);
        }
        if (rule?.kind === 'checkbox' && model?._rowClass !== 'header-row') {
          return renderCheckboxCell(h, isCheckboxChecked(rule, String(raw ?? '')));
        }
        // Link and tracker cells draw structure, not just formatted text.
        if (format?.type === 'tracker' && trackerStore && shownValue(value) === value) return renderTrackerCell(h, value, trackerStore);
        return renderValueCell(h, value, format);
      },
      cellProperties: (cellData: { model: Record<string, unknown>; rowIndex: number }) => {
        const classes: Record<string, boolean> = {};
        const isPinned = cellData.model._rowClass === 'header-row';
        const row = rows.rowOf(cellData.model);
        const format = row === undefined ? decorations.formatAt(-1, index) : decorations.formatAt(row, index);
        let inline: Record<string, string> | null = null;
        let invalidMessage: string | undefined;
        if (isHidden) classes['csv-cell-hidden'] = true;

        // Alignment. An explicit format wins; otherwise right-align values that
        // read as numbers, leaving text against the left edge. Header rows stay
        // left-aligned: a header is a label, not a measurement. The value tested
        // is the *displayed* one, so a formula aligns by its result.
        const alignClass = getAlignmentClass(format);
        if (alignClass) {
          classes[alignClass] = true;
        } else if (!isPinned && isNumericCellValue(displayOf(cellData.model))) {
          classes['cell-align-right'] = true;
        }

        // Red negatives are a class rather than a decorated string, so the cell
        // still copies as a plain number.
        if (format && !isPinned && usesRedNegatives(format.negativeStyle)) {
          const displayed = displayOf(cellData.model);
          const numeric = typeof displayed === 'string' || typeof displayed === 'number' ? displayed : null;
          if (isNegativeFormattedValue(numeric, format)) classes['csv-cell-negative'] = true;
        }

        if (row !== undefined) {
          // Range styling, with any conditional format layered over it so a
          // rule's fill beats a static fill on the same cell.
          const base = cellStyleIndex.isEmpty ? null : cellStyleIndex.styleAt(row, index);
          const style = paintedStyle(base, isPinned ? null : conditional.styleAt(row, index));
          if (style) {
            for (const className of styleClassNames(style)) classes[className] = true;
            inline = styleInlineCss(style);
          }
          if (decorations.hasWrap && decorations.wraps(row, index)) classes['csv-cell-wrap'] = true;
          const borders = decorations.borderCssAt(row, index);
          if (borders) inline = { ...(inline ?? {}), ...borders };

          const rule = isPinned ? null : decorations.validationAt(row, index);
          if (rule) {
            const result = validateCellValue(rule, String(cellData.model[letter] ?? ''));
            if (!result.valid) {
              classes['csv-cell-invalid'] = true;
              invalidMessage = result.message;
            }
            if (rule.kind === 'list') classes['csv-cell-list'] = true;
            if (rule.kind === 'checkbox') classes['csv-cell-checkbox'] = true;
          }
        }

        // Find-match highlight, keyed by row model rather than row index so it
        // survives pinned rows and filtered-out rows alike.
        const findState = findHighlightRef.current?.get(cellData.model)?.get(letter);
        if (findState !== undefined) {
          classes['csv-find-match'] = true;
          classes['csv-find-current'] = findState;
        }

        if (aiFlashRef.current?.get(cellData.model)?.has(letter)) {
          classes['csv-ai-cell-flash'] = true;
        }

        if (diffState?.isActive) {
          const diffClass = getCellDiffClass(diffState, cellData.rowIndex, letter, isPinned);
          if (diffClass) classes[diffClass] = true;
        }

        const props: { class?: Record<string, boolean>; title?: string; style?: Record<string, string> } = {};
        if (Object.keys(classes).length > 0) props.class = classes;
        if (inline) props.style = inline;
        if (invalidMessage) props.title = invalidMessage;

        // Tooltip for the previous value on modified/deleted cells.
        if (diffState?.isActive) {
          const previousValue = getCellPreviousValue(diffState, cellData.rowIndex, letter, isPinned);
          if (previousValue !== undefined) props.title = `Previous: ${previousValue}`;
        }
        return props;
      },
    };
  });
}
