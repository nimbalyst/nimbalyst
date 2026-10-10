/**
 * What the column templates sample at paint time beyond the column format:
 * the logical row of a row model, and conditional-format styles.
 *
 * Both read the grid's row arrays lazily and rebuild only when those arrays
 * change identity, which every command and every whole-source load does (the
 * executor replaces `source` / `pinnedTopSource` rather than mutating them).
 * A scroll repaint therefore costs a map lookup per cell.
 */

import { columnIndexToLetter } from '../utils/csvParser';
import { isNumericCellValue, parseNumber, shownValue } from '../utils/formatters';
import { evaluateConditionalFormats, prepareConditionalFormats, type PreparedConditionalFormats } from '../conditional/evaluate';
import type { ConditionalCellSnapshot, ConditionalFormat, ConditionalStylePatch } from '../conditional/types';

type RowModel = Record<string, unknown>;

export interface GridRows {
  readonly source: readonly RowModel[];
  readonly pinnedTop: readonly RowModel[];
}

export type ReadGridRows = () => GridRows | null;
export type DisplayValue = (model: RowModel, prop: string) => unknown;

/** Logical sheet row of each row model, independent of filters and hidden rows. */
export class LogicalRowIndex {
  private rows: GridRows | null = null;
  private index = new WeakMap<object, number>();

  constructor(private readonly read: ReadGridRows) {}

  private current(): GridRows | null {
    const rows = this.read();
    if (!rows) return null;
    if (!this.rows || this.rows.source !== rows.source || this.rows.pinnedTop !== rows.pinnedTop) {
      this.rows = rows;
      this.index = new WeakMap();
      rows.pinnedTop.forEach((model, i) => this.index.set(model, i));
      rows.source.forEach((model, i) => this.index.set(model, rows.pinnedTop.length + i));
    }
    return this.rows;
  }

  rowOf(model: object): number | undefined {
    this.current();
    return this.index.get(model);
  }

  modelAt(row: number): RowModel | undefined {
    const rows = this.current();
    if (!rows) return undefined;
    return row < rows.pinnedTop.length ? rows.pinnedTop[row] : rows.source[row - rows.pinnedTop.length];
  }

  /** Identity of the data the index was built from; changes on every write. */
  get revisionKey(): GridRows | null {
    return this.current();
  }
}

/** A cell as the conditional evaluator sees it: raw text, displayed value, number. */
export function conditionalSnapshot(model: RowModel | undefined, col: number, display: DisplayValue): ConditionalCellSnapshot {
  const prop = columnIndexToLetter(col);
  const raw = model?.[prop];
  const shown = shownValue(model ? display(model, prop) ?? raw : raw);
  const rawText = raw === undefined || raw === null ? '' : String(raw);
  const displayText = shown === undefined || shown === null ? '' : String(shown);
  const numeric = typeof shown === 'number'
    ? shown
    : (isNumericCellValue(displayText) ? parseNumber(displayText) : null);
  return { raw: rawText, display: displayText, numeric };
}

export class ConditionalPainter {
  private prepared: PreparedConditionalFormats | null = null;
  private preparedFor: GridRows | null = null;
  private readonly cache = new Map<string, ConditionalStylePatch | null>();

  constructor(
    private readonly formats: readonly ConditionalFormat[],
    private readonly rows: LogicalRowIndex,
    private readonly display: DisplayValue,
    private readonly extent: () => { rowCount: number; colCount: number },
  ) {}

  get isEmpty(): boolean {
    return this.formats.length === 0;
  }

  private getCell = (row: number, col: number) => conditionalSnapshot(this.rows.modelAt(row), col, this.display);

  styleAt(row: number, col: number): ConditionalStylePatch | null {
    if (this.formats.length === 0) return null;
    const data = this.rows.revisionKey;
    if (!this.prepared || this.preparedFor !== data) {
      this.prepared = prepareConditionalFormats(this.formats, this.getCell, this.extent());
      this.preparedFor = data;
      this.cache.clear();
    }
    const key = `${row}:${col}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const { styles } = evaluateConditionalFormats(this.formats, this.getCell,
      { startRow: row, endRow: row, startCol: col, endCol: col }, { prepared: this.prepared });
    const style = styles.get(key) ?? null;
    this.cache.set(key, style);
    return style;
  }
}
