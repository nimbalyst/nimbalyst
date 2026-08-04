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

/** A range expressed in one section's local coordinates. */
export interface LocalRange {
  storeX: number;
  storeY: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
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
    const rowStart = Math.max(range.startRow, rowSection.offset);
    const rowEnd = Math.min(range.endRow, rowSection.offset + rowSection.count - 1);
    if (rowStart > rowEnd) continue;

    for (const colSection of sections.cols) {
      const colStart = Math.max(range.startCol, colSection.offset);
      const colEnd = Math.min(range.endCol, colSection.offset + colSection.count - 1);
      if (colStart > colEnd) continue;

      out.push({
        storeX: colSection.storeIndex,
        storeY: rowSection.storeIndex,
        start: { x: colStart - colSection.offset, y: rowStart - rowSection.offset },
        end: { x: colEnd - colSection.offset, y: rowEnd - rowSection.offset },
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

/** Minimal shape of the `revo-grid` element we depend on. */
export interface SectionAwareGrid extends HTMLElement {
  getProviders(): Promise<RevoProviders | undefined>;
}

/**
 * Read the current section layout off a live grid.
 *
 * Section cell counts come from each store's `lastCell`, which RevoGrid keeps
 * in sync with the dimension stores, so this reflects live freeze/unfreeze and
 * header-row changes without us tracking them separately.
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

  return {
    cols: buildAxisSections(connector.storesXToType, colCounts, COL_TYPE_ORDER),
    rows: buildAxisSections(connector.storesYToType, rowCounts, ROW_TYPE_ORDER),
  };
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

  for (const [yKey, row] of Object.entries(connector.stores)) {
    for (const [xKey, store] of Object.entries(row)) {
      if (!store) continue;
      const local = wantedByStore.get(`${Number(yKey)}:${Number(xKey)}`);
      if (local) {
        store.setRange(local.start, local.end);
      } else {
        store.setRangeArea(null);
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
