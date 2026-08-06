/**
 * Cross-section selection support.
 *
 * RevoGrid does not keep one selection; it keeps a matrix of SelectionStores,
 * one per viewport section (frozen columns x pinned rows x scrollable body).
 * Each store addresses cells in *section-local* coordinates and paints its own
 * overlay. A logical range that crosses a frozen boundary is therefore not
 * representable in a single store -- but it is representable as one clipped
 * range per store, which is exactly what RevoGrid's own `selectAll()` does.
 *
 * RevoGrid's built-in drag can't produce such a range: `AutoFillService`
 * resolves the pointer against the originating section's dimensions and clamps
 * with `isAfterLast(current, data.lastCell)`, so a drag can never leave the
 * section it started in. We therefore own the drag (hit-test the pointer to
 * absolute sheet coordinates ourselves) and own the paint (fan the logical
 * range out across stores).
 *
 * Everything above `resolveGridSections` is pure so the coordinate math can be
 * tested without a live grid.
 */

import type { NormalizedSelectionRange } from '../types';

export type DimensionColType = 'colPinStart' | 'rgCol' | 'colPinEnd';
export type DimensionRowType = 'rowPinStart' | 'rgRow' | 'rowPinEnd';

/** Canonical left-to-right / top-to-bottom order of the viewport sections. */
const COL_TYPE_ORDER: DimensionColType[] = ['colPinStart', 'rgCol', 'colPinEnd'];
const ROW_TYPE_ORDER: DimensionRowType[] = ['rowPinStart', 'rgRow', 'rowPinEnd'];

/** One viewport section along a single axis. */
export interface AxisSection<TType extends string> {
  type: TType;
  /** Index of this section's store on its axis (the x or y in stores[y][x]). */
  storeIndex: number;
  /** Absolute sheet index of this section's first cell. */
  offset: number;
  /** Number of cells this section spans. */
  count: number;
}

export interface GridSections {
  cols: AxisSection<DimensionColType>[];
  rows: AxisSection<DimensionRowType>[];
}

/**
 * Sides on which a clipped range continues into a neighbouring section.
 *
 * Each section paints its own border, so an open side is a seam: a line drawn
 * straight through the middle of what the user sees as one rectangle. The paint
 * step marks these sides on the DOM so the stylesheet can drop those edges.
 */
export interface OpenEdges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/** A range expressed in one section's local coordinates. */
export interface LocalRange {
  storeX: number;
  storeY: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
  open: OpenEdges;
}

/**
 * Build the axis sections from raw store metadata.
 *
 * `counts` is keyed by store index and holds each section's cell count on that
 * axis (RevoGrid's `lastCell` is an exclusive bound, so it doubles as a count).
 * Sections are ordered canonically rather than by store index, because store
 * registration order is not guaranteed to match visual order.
 */
export function buildAxisSections<TType extends string>(
  typeByStoreIndex: Record<number, TType | undefined>,
  counts: Record<number, number>,
  order: readonly TType[]
): AxisSection<TType>[] {
  const entries = Object.entries(typeByStoreIndex)
    .map(([storeIndex, type]) => ({ storeIndex: Number(storeIndex), type }))
    .filter((e): e is { storeIndex: number; type: TType } => !!e.type && order.includes(e.type))
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

  const sections: AxisSection<TType>[] = [];
  let offset = 0;
  for (const entry of entries) {
    const count = counts[entry.storeIndex] ?? 0;
    sections.push({ type: entry.type, storeIndex: entry.storeIndex, offset, count });
    offset += count;
  }
  return sections;
}

/** Find a section by its type. */
function sectionOfType<TType extends string>(
  sections: AxisSection<TType>[],
  type: TType
): AxisSection<TType> | null {
  return sections.find(s => s.type === type) ?? null;
}

/**
 * Convert a section-local cell to absolute sheet coordinates.
 * Returns null when the section isn't part of the grid (e.g. the row-number
 * gutter, whose colType is `rowHeaders`).
 */
export function toAbsoluteCell(
  sections: GridSections,
  colType: string,
  rowType: string,
  localCol: number,
  localRow: number
): { row: number; col: number } | null {
  const col = sectionOfType(sections.cols, colType as DimensionColType);
  const row = sectionOfType(sections.rows, rowType as DimensionRowType);
  if (!col || !row) return null;
  return { row: row.offset + localRow, col: col.offset + localCol };
}

/**
 * Clip a logical range to each section it overlaps, in that section's local
 * coordinates. Sections the range misses are omitted; the caller clears them.
 */
export function toLocalRanges(
  sections: GridSections,
  range: NormalizedSelectionRange
): LocalRange[] {
  const out: LocalRange[] = [];

  for (const rowSection of sections.rows) {
    const rowLast = rowSection.offset + rowSection.count - 1;
    const rowStart = Math.max(range.startRow, rowSection.offset);
    const rowEnd = Math.min(range.endRow, rowLast);
    if (rowStart > rowEnd) continue;

    for (const colSection of sections.cols) {
      const colLast = colSection.offset + colSection.count - 1;
      const colStart = Math.max(range.startCol, colSection.offset);
      const colEnd = Math.min(range.endCol, colLast);
      if (colStart > colEnd) continue;

      out.push({
        storeX: colSection.storeIndex,
        storeY: rowSection.storeIndex,
        start: { x: colStart - colSection.offset, y: rowStart - rowSection.offset },
        end: { x: colEnd - colSection.offset, y: rowEnd - rowSection.offset },
        open: {
          top: range.startRow < rowSection.offset,
          bottom: range.endRow > rowLast,
          left: range.startCol < colSection.offset,
          right: range.endCol > colLast,
        },
      });
    }
  }

  return out;
}

/** Total addressable extent of the grid, summed across sections. */
export function gridBounds(sections: GridSections): { lastRow: number; lastCol: number } {
  return {
    lastRow: Math.max(0, sections.rows.reduce((n, s) => n + s.count, 0) - 1),
    lastCol: Math.max(0, sections.cols.reduce((n, s) => n + s.count, 0) - 1),
  };
}

/** Clamp an absolute cell to the grid's addressable bounds. */
export function clampToGrid(
  sections: GridSections,
  cell: { row: number; col: number }
): { row: number; col: number } {
  const { lastRow, lastCol } = gridBounds(sections);
  return {
    row: Math.max(0, Math.min(cell.row, lastRow)),
    col: Math.max(0, Math.min(cell.col, lastCol)),
  };
}

/* ------------------------------------------------------------------------- */
/* Live-grid adapters                                                         */
/* ------------------------------------------------------------------------- */

/** The slice of RevoGrid's SelectionStore we drive. */
interface RevoSelectionStore {
  store: { get(key: 'lastCell'): { x: number; y: number } | null };
  setRange(start: { x: number; y: number }, end: { x: number; y: number }): void;
  setRangeArea(range: unknown | null): void;
  clearFocus(): void;
}

interface RevoSelectionConnector {
  stores: Record<number, Record<number, RevoSelectionStore | undefined>>;
  storesXToType: Record<number, DimensionColType | undefined>;
  storesYToType: Record<number, DimensionRowType | undefined>;
}

interface RevoProviders {
  selection: RevoSelectionConnector;
}

/** The one column-definition field that decides which section a column is in. */
export interface PinnableColumn {
  pin?: string;
}

/** Minimal shape of the `revo-grid` element we depend on. */
export interface SectionAwareGrid extends HTMLElement {
  getProviders(): Promise<RevoProviders | undefined>;
  columns?: PinnableColumn[];
}

/**
 * Reconstruct which column store holds which section, from the column
 * definitions.
 *
 * RevoGrid's own `storesXToType` cannot be trusted after a runtime freeze:
 * `registerColumn` early-returns for an already-registered store index without
 * updating its type, so freezing a column leaves store 0 still labelled
 * `rgCol` even though it now holds the frozen section -- and every lookup by
 * type then misses. Column stores are indexed in canonical order across the
 * sections that have at least one column, which is exactly what the pins say.
 */
export function colTypesFromColumns(
  columns: readonly PinnableColumn[]
): Record<number, DimensionColType> {
  const counts: Record<DimensionColType, number> = { colPinStart: 0, rgCol: 0, colPinEnd: 0 };
  for (const column of columns) {
    const pin = column?.pin;
    counts[pin === 'colPinStart' || pin === 'colPinEnd' ? pin : 'rgCol']++;
  }

  const typeByStoreIndex: Record<number, DimensionColType> = {};
  let storeIndex = 0;
  for (const type of COL_TYPE_ORDER) {
    if (counts[type] > 0) typeByStoreIndex[storeIndex++] = type;
  }
  return typeByStoreIndex;
}

/**
 * Read the current section layout off a live grid.
 *
 * Section cell counts come from each store's `lastCell`, which RevoGrid keeps
 * in sync with the dimension stores, so this reflects live freeze/unfreeze and
 * header-row changes without us tracking them separately. Row store types are
 * read straight off the connector: all three row sections are registered once
 * at mount and never re-registered, so they can't go stale the way the column
 * ones can.
 */
export async function resolveGridSections(grid: SectionAwareGrid): Promise<GridSections | null> {
  const providers = await grid.getProviders();
  const connector = providers?.selection;
  if (!connector) return null;

  const colCounts: Record<number, number> = {};
  const rowCounts: Record<number, number> = {};

  for (const [yKey, row] of Object.entries(connector.stores)) {
    const y = Number(yKey);
    for (const [xKey, store] of Object.entries(row)) {
      const x = Number(xKey);
      const lastCell = store?.store.get('lastCell');
      if (!lastCell) continue;
      // Every store on a column reports the same width, and every store on a
      // row the same height; last write wins is fine.
      colCounts[x] = lastCell.x;
      rowCounts[y] = lastCell.y;
    }
  }

  const colTypes = grid.columns?.length
    ? colTypesFromColumns(grid.columns)
    : connector.storesXToType;

  return {
    cols: buildAxisSections(colTypes, colCounts, COL_TYPE_ORDER),
    rows: buildAxisSections(connector.storesYToType, rowCounts, ROW_TYPE_ORDER),
  };
}

/** Attribute set on a section's overlay for each side that is a seam. */
const OPEN_EDGE_ATTRIBUTES: Record<keyof OpenEdges, string> = {
  top: 'data-csv-open-top',
  right: 'data-csv-open-right',
  bottom: 'data-csv-open-bottom',
  left: 'data-csv-open-left',
};

/**
 * The overlay element that paints a given section's selection border. Located
 * through its cell canvas, which is the only node carrying both section types.
 */
function overlayForSection(
  grid: SectionAwareGrid,
  colType: string,
  rowType: string
): HTMLElement | null {
  const data = grid.querySelector(`revogr-data[col-type="${colType}"][type="${rowType}"]`);
  return data?.closest('revogr-overlay-selection') ?? null;
}

/** Mark (or clear) the sides on which this section's border would be a seam. */
function markOpenEdges(overlay: HTMLElement | null, open: OpenEdges | null): void {
  if (!overlay) return;
  for (const [side, attribute] of Object.entries(OPEN_EDGE_ATTRIBUTES)) {
    overlay.toggleAttribute(attribute, !!open?.[side as keyof OpenEdges]);
  }
}

/**
 * Paint a logical range across every section it touches.
 *
 * Stores outside the range are cleared so a shrinking drag doesn't strand
 * highlight in a section the pointer has left.
 */
export async function paintCrossSectionRange(
  grid: SectionAwareGrid,
  sections: GridSections,
  range: NormalizedSelectionRange | null
): Promise<void> {
  const providers = await grid.getProviders();
  const connector = providers?.selection;
  if (!connector) return;

  const wanted = range ? toLocalRanges(sections, range) : [];
  const wantedByStore = new Map(wanted.map(r => [`${r.storeY}:${r.storeX}`, r]));
  const colTypeByStore = new Map(sections.cols.map(s => [s.storeIndex, s.type]));
  const rowTypeByStore = new Map(sections.rows.map(s => [s.storeIndex, s.type]));

  for (const [yKey, row] of Object.entries(connector.stores)) {
    const y = Number(yKey);
    for (const [xKey, store] of Object.entries(row)) {
      if (!store) continue;
      const x = Number(xKey);
      const local = wantedByStore.get(`${y}:${x}`);
      if (local) {
        store.setRange(local.start, local.end);
      } else {
        store.setRangeArea(null);
      }

      const colType = colTypeByStore.get(x);
      const rowType = rowTypeByStore.get(y);
      if (colType && rowType) {
        markOpenEdges(overlayForSection(grid, colType, rowType), local?.open ?? null);
      }
    }
  }
}

/**
 * Hit-test a viewport point to an absolute cell.
 *
 * Reads the section types off the cell's own `revogr-data` ancestor rather than
 * inferring them from geometry, so frozen widths and scroll offsets don't
 * matter. Returns null for the row-number gutter and for points outside cells.
 */
export function cellFromPoint(
  sections: GridSections,
  clientX: number,
  clientY: number
): { row: number; col: number } | null {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;

  const cell = el.closest('[data-rgcol][data-rgrow]') as HTMLElement | null;
  if (!cell) return null;

  const dataSection = cell.closest('revogr-data');
  if (!dataSection) return null;

  const colType = dataSection.getAttribute('col-type');
  const rowType = dataSection.getAttribute('type');
  if (!colType || !rowType || colType === 'rowHeaders') return null;

  const localCol = Number(cell.getAttribute('data-rgcol'));
  const localRow = Number(cell.getAttribute('data-rgrow'));
  if (!Number.isFinite(localCol) || !Number.isFinite(localRow)) return null;

  return toAbsoluteCell(sections, colType, rowType, localCol, localRow);
}

/** The column section an element belongs to, read off the DOM. */
function sectionColType(element: Element): string | null {
  const data = element.closest('revogr-data') ?? element.querySelector('revogr-data');
  if (data) return data.getAttribute('col-type');

  const viewport = element.closest('revogr-viewport-scroll');
  return COL_TYPE_ORDER.find(type => viewport?.classList.contains(type)) ?? null;
}

/**
 * Absolute column index for a section-local one.
 *
 * `data-rgcol`, RevoGrid's focus events and its range events all report the
 * index *within a section*: with two frozen columns the first scrollable column
 * is 0, not 2. Taking those at face value addresses the wrong column entirely,
 * so every DOM- or event-sourced column index has to come through here.
 *
 * `element` is anything inside the section -- a cell, a header cell, or the
 * overlay that emitted the event. This editor only ever pins to the start, so
 * anything outside the pinned section is offset by the full frozen width.
 */
export function toAbsoluteColumn(
  element: Element | null,
  localCol: number,
  frozenColumnCount: number
): number {
  if (!element) return localCol;
  return sectionColType(element) === 'colPinStart' ? localCol : localCol + frozenColumnCount;
}

/**
 * Everything {@link resolveHeaderColumnIndex} needs about a column header,
 * lifted off the DOM in one place so the resolver itself stays pure.
 */
export interface HeaderColumnTarget {
  /** `data-rgcol`, verbatim. Section-local, like every other RevoGrid index. */
  readonly sectionColumn: string | null;
  readonly isPinnedColumn: boolean;
}

/** Read a column header's structured column identity. */
export function readHeaderColumnTarget(header: Element): HeaderColumnTarget {
  return {
    sectionColumn: header.getAttribute('data-rgcol'),
    isPinnedColumn: sectionColType(header) === 'colPinStart',
  };
}

/**
 * Sheet column index for a clicked or right-clicked column header.
 *
 * The header's rendered text is *not* a source of truth. `columnTemplate`
 * appends a filter funnel glyph, so a header's `textContent` reads `A▼`, and
 * parsing that as a column letter yields column 9621 -- which is how a
 * "Delete Column" on A once deleted a different column entirely. The index
 * comes from `data-rgcol`, which no decoration can reach.
 */
export function resolveHeaderColumnIndex(
  target: HeaderColumnTarget,
  frozenColumnCount: number
): number | null {
  if (target.sectionColumn === null || target.sectionColumn.trim() === '') return null;
  const sectionColumn = Number(target.sectionColumn);
  if (!Number.isInteger(sectionColumn) || sectionColumn < 0) return null;
  return target.isPinnedColumn ? sectionColumn : sectionColumn + frozenColumnCount;
}

/**
 * The inverse of {@link toAbsoluteColumn}: split a sheet column index back into
 * the section-local pair RevoGrid's own write APIs expect.
 *
 * `grid.setDataAt({ col, colType })` resolves `col` *within* `colType`, so
 * passing a sheet-wide index with a hardcoded `colType: 'rgCol'` writes
 * `frozenColumnCount` columns to the right of the intended one.
 */
export function toSectionColumn(
  absoluteCol: number,
  frozenColumnCount: number
): { col: number; colType: DimensionColType } {
  return absoluteCol < frozenColumnCount
    ? { col: absoluteCol, colType: 'colPinStart' }
    : { col: absoluteCol - frozenColumnCount, colType: 'rgCol' };
}

/**
 * Nearest cell to a point, for drags that run past the edge of the data.
 *
 * A pointer below the last row is still horizontally over a valid column, and
 * one past the right edge is still vertically over a valid row. So when the
 * direct hit-test misses we re-probe each axis against the drag anchor's other
 * coordinate, and only then fall back to the last known cell. Without this a
 * drag that overshoots the data freezes instead of extending.
 */
export function nearestCellFromPoint(
  sections: GridSections,
  point: { clientX: number; clientY: number },
  anchor: { clientX: number; clientY: number },
  fallback: { row: number; col: number }
): { row: number; col: number } {
  const direct = cellFromPoint(sections, point.clientX, point.clientY);
  if (direct) return direct;

  const byColumn = cellFromPoint(sections, point.clientX, anchor.clientY);
  const byRow = cellFromPoint(sections, anchor.clientX, point.clientY);

  return clampToGrid(sections, {
    row: byRow?.row ?? fallback.row,
    col: byColumn?.col ?? fallback.col,
  });
}
