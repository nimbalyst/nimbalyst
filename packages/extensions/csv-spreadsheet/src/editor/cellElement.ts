/**
 * The rendered DOM cell for a logical sheet cell, or null when it is scrolled
 * out of the viewport, filtered or hidden. Popovers anchor to its rect.
 */

import type { EditorCore } from './editorCore';

export function findCellElement(core: EditorCore, row: number, col: number): HTMLElement | null {
  const container = core.gridContainerRef.current;
  const grid = core.revoGridRef.current as unknown as { pinnedTopSource?: unknown[] } | null;
  if (!container || !grid) return null;
  const pinned = grid.pinnedTopSource?.length ?? 0;
  const visible = core.rowSpaceRef.current.logicalToVisible(row);
  if (visible === undefined) return null;
  const { frozenColumnCount } = core.spreadsheetMetaRef.current.getMetadata();
  const rowType = visible < pinned ? 'rowPinStart' : 'rgRow';
  const y = visible < pinned ? visible : visible - pinned;
  const colType = col < frozenColumnCount ? 'colPinStart' : 'rgCol';
  const x = col < frozenColumnCount ? col : col - frozenColumnCount;
  for (const candidate of container.querySelectorAll<HTMLElement>(`revogr-data[type="${rowType}"] [data-rgrow="${y}"][data-rgcol="${x}"]`)) {
    if (candidate.closest('revogr-viewport-scroll')?.classList.contains(colType)) return candidate;
  }
  return null;
}
