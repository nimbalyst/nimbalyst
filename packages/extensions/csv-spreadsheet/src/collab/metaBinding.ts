/**
 * Spreadsheet metadata <-> Y.Doc binding.
 *
 * Metadata used to sync only as a side effect of the CSV text: it lives in a
 * single `# nimbalyst: {...}` comment line, and that line is one line inside
 * the whole-file `Y.Text`. Two people formatting two *different* columns at the
 * same time therefore produced overlapping replacements of the same line, and
 * the merge kept a mangled or last-writer version rather than both formats.
 *
 * This gives metadata its own key instead, with one CRDT entry per column, so
 * concurrent edits to different columns merge the way a user expects. The
 * `Y.Text` still carries the full CSV *including* the comment line, so the doc
 * shape is unchanged and a client running an older build still reads a sane
 * file — the comment line simply becomes derived output, regenerated on save
 * from whatever this map merged to.
 */

import * as Y from 'yjs';
import type { CellStyle, CellStyleRanges, ColumnFormat } from '../types';

export const Y_META_MAP = 'meta';

/** Top-level metadata keys held as their own CRDT entries. */
const KEY_HEADER_ROWS = 'headerRowCount';
const KEY_FROZEN_COLUMNS = 'frozenColumnCount';
const KEY_COLUMN_FORMATS = 'columnFormats';
const KEY_COLUMN_WIDTHS = 'columnWidths';
const KEY_CELL_STYLES = 'cellStyles';

export interface CsvMetaSnapshot {
  headerRowCount: number;
  frozenColumnCount: number;
  columnFormats: Record<number, ColumnFormat>;
  columnWidths: Record<number, number>;
  /** Keyed by A1 range rather than column index, so this one stays a string map. */
  cellStyles: CellStyleRanges;
}

export function getYMeta(yDoc: Y.Doc): Y.Map<unknown> {
  return yDoc.getMap(Y_META_MAP);
}

/** True when no client has populated metadata yet, so this one may seed it. */
export function isMetaEmpty(yDoc: Y.Doc): boolean {
  return getYMeta(yDoc).size === 0;
}

function readNested(meta: Y.Map<unknown>, key: string): Y.Map<unknown> | null {
  const value = meta.get(key);
  return value instanceof Y.Map ? value : null;
}

function nestedToStringRecord<T>(map: Y.Map<unknown> | null): Record<string, T> {
  const record: Record<string, T> = {};
  if (!map) return record;
  for (const [key, value] of map.entries()) {
    if (value === undefined || value === null) continue;
    record[key] = value as T;
  }
  return record;
}

function nestedToRecord<T>(map: Y.Map<unknown> | null): Record<number, T> {
  const record: Record<number, T> = {};
  if (!map) return record;
  for (const [key, value] of map.entries()) {
    const index = Number(key);
    if (!Number.isInteger(index) || value === undefined || value === null) continue;
    record[index] = value as T;
  }
  return record;
}

export interface CsvMetaBindingOptions {
  /** Called when another client changed metadata. Never fires for local writes. */
  onRemoteMeta: (snapshot: CsvMetaSnapshot) => void;
}

export class CsvMetaBinding {
  private readonly yDoc: Y.Doc;
  private readonly meta: Y.Map<unknown>;
  private readonly localOrigin = Symbol('csv-meta-local');
  private readonly observer: () => void;
  private destroyed = false;
  /** Last snapshot this client wrote, so `publish` only touches real changes. */
  private lastPublished: CsvMetaSnapshot | null = null;

  constructor(yDoc: Y.Doc, private readonly opts: CsvMetaBindingOptions) {
    this.yDoc = yDoc;
    this.meta = getYMeta(yDoc);

    this.observer = () => {
      if (this.destroyed) return;
      const snapshot = this.snapshot();
      this.lastPublished = snapshot;
      this.opts.onRemoteMeta(snapshot);
    };
    // Deep, because the per-column entries are nested maps.
    this.meta.observeDeep(this.onDeepChange);
  }

  private onDeepChange = (_events: unknown, transaction: Y.Transaction): void => {
    // Our own writes already match local state; echoing them back would fight
    // the user's in-flight edits.
    if (transaction.origin === this.localOrigin) return;
    this.observer();
  };

  snapshot(): CsvMetaSnapshot {
    return {
      headerRowCount: Number(this.meta.get(KEY_HEADER_ROWS) ?? 0),
      frozenColumnCount: Number(this.meta.get(KEY_FROZEN_COLUMNS) ?? 0),
      columnFormats: nestedToRecord<ColumnFormat>(readNested(this.meta, KEY_COLUMN_FORMATS)),
      columnWidths: nestedToRecord<number>(readNested(this.meta, KEY_COLUMN_WIDTHS)),
      cellStyles: nestedToStringRecord<CellStyle>(readNested(this.meta, KEY_CELL_STYLES)),
    };
  }

  /**
   * Write a local metadata change.
   *
   * Only entries that actually differ are touched, so formatting column B never
   * writes column A's key and cannot clobber a collaborator's concurrent edit
   * to it.
   */
  publish(snapshot: CsvMetaSnapshot): void {
    if (this.destroyed) return;
    const previous = this.lastPublished;
    if (previous && sameSnapshot(previous, snapshot)) return;

    this.yDoc.transact(() => {
      if (this.meta.get(KEY_HEADER_ROWS) !== snapshot.headerRowCount) {
        this.meta.set(KEY_HEADER_ROWS, snapshot.headerRowCount);
      }
      if (this.meta.get(KEY_FROZEN_COLUMNS) !== snapshot.frozenColumnCount) {
        this.meta.set(KEY_FROZEN_COLUMNS, snapshot.frozenColumnCount);
      }
      this.publishNested(KEY_COLUMN_FORMATS, snapshot.columnFormats, jsonEquals);
      this.publishNested(KEY_COLUMN_WIDTHS, snapshot.columnWidths, (a, b) => a === b);
      // One entry per styled range, so two people styling two different blocks
      // merge the same way two people formatting two columns do.
      this.publishNested(KEY_CELL_STYLES, snapshot.cellStyles, jsonEquals);
    }, this.localOrigin);

    this.lastPublished = snapshot;
  }

  private publishNested<T>(
    key: string,
    values: Record<string | number, T>,
    equals: (a: T, b: T) => boolean,
  ): void {
    let nested = readNested(this.meta, key);
    if (!nested) {
      nested = new Y.Map();
      this.meta.set(key, nested);
    }

    for (const [indexText, value] of Object.entries(values)) {
      const existing = nested.get(indexText) as T | undefined;
      if (existing === undefined || !equals(existing, value)) {
        nested.set(indexText, value);
      }
    }
    // A cleared format is a real edit and has to propagate as a deletion.
    for (const indexText of [...nested.keys()]) {
      if (!(indexText in values)) nested.delete(indexText);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.meta.unobserveDeep(this.onDeepChange);
  }
}

function jsonEquals<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameSnapshot(a: CsvMetaSnapshot, b: CsvMetaSnapshot): boolean {
  return a.headerRowCount === b.headerRowCount
    && a.frozenColumnCount === b.frozenColumnCount
    && jsonEquals(a.columnFormats, b.columnFormats)
    && jsonEquals(a.columnWidths, b.columnWidths)
    && jsonEquals(a.cellStyles, b.cellStyles);
}
