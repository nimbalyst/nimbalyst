/**
 * Spatial index from a cell to the formulas whose reference areas cover it,
 * value cells included. This is what lets a value typed anywhere in column A
 * find `=SUM(A:A)`, which has no graph edge to a non-formula cell.
 */

import { cellKey, type CellRect } from './types';

/** Ranges at most this many columns wide are bucketed per column. */
const MAX_BUCKETED_WIDTH = 16;

interface CoverageEntry {
  nodeKey: string;
  rect: CellRect;
}

export class CoverageIndex {
  private readonly singleCells = new Map<string, Set<string>>();
  private readonly columns = new Map<number, Set<CoverageEntry>>();
  private readonly wide = new Set<CoverageEntry>();
  private readonly entriesByNode = new Map<string, CoverageEntry[]>();

  add(nodeKey: string, rects: CellRect[]): void {
    if (rects.length === 0) return;
    const entries: CoverageEntry[] = [];
    for (const rect of rects) {
      const entry: CoverageEntry = { nodeKey, rect };
      entries.push(entry);
      if (rect.minRow === rect.maxRow && rect.minCol === rect.maxCol) {
        const key = cellKey(rect.minRow, rect.minCol);
        let owners = this.singleCells.get(key);
        if (!owners) this.singleCells.set(key, owners = new Set());
        owners.add(nodeKey);
      } else if (rect.maxCol - rect.minCol < MAX_BUCKETED_WIDTH) {
        for (let col = rect.minCol; col <= rect.maxCol; col += 1) {
          let bucket = this.columns.get(col);
          if (!bucket) this.columns.set(col, bucket = new Set());
          bucket.add(entry);
        }
      } else {
        this.wide.add(entry);
      }
    }
    this.entriesByNode.set(nodeKey, entries);
  }

  remove(nodeKey: string): void {
    const entries = this.entriesByNode.get(nodeKey);
    if (!entries) return;
    for (const entry of entries) {
      const { rect } = entry;
      if (rect.minRow === rect.maxRow && rect.minCol === rect.maxCol) {
        const key = cellKey(rect.minRow, rect.minCol);
        const owners = this.singleCells.get(key);
        owners?.delete(nodeKey);
        if (owners?.size === 0) this.singleCells.delete(key);
      } else if (rect.maxCol - rect.minCol < MAX_BUCKETED_WIDTH) {
        for (let col = rect.minCol; col <= rect.maxCol; col += 1) this.columns.get(col)?.delete(entry);
      } else {
        this.wide.delete(entry);
      }
    }
    this.entriesByNode.delete(nodeKey);
  }

  /** Add every formula whose areas contain (row, col) to `into`. */
  collectCovering(row: number, col: number, into: Set<string>): void {
    for (const nodeKey of this.singleCells.get(cellKey(row, col)) ?? []) into.add(nodeKey);
    for (const entry of this.columns.get(col) ?? []) {
      if (entry.rect.minRow <= row && row <= entry.rect.maxRow) into.add(entry.nodeKey);
    }
    for (const entry of this.wide) {
      const { rect } = entry;
      if (rect.minRow <= row && row <= rect.maxRow && rect.minCol <= col && col <= rect.maxCol) {
        into.add(entry.nodeKey);
      }
    }
  }
}
