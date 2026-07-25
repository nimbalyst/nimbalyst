/**
 * Pure helpers for CSV collaboration presence.
 *
 * These are deliberately free of Yjs/DOM dependencies so they can be
 * unit-tested directly. The binding feeds them raw awareness states; the
 * overlay feeds them a logical cell + header count.
 */

/** A cell coordinate in the editor's logical space (see `resolveCellSection`). */
export interface PresenceCell {
  row: number;
  col: number;
}

/** One remote collaborator's presence, ready for rendering. */
export interface RemotePresence {
  userId: string;
  name: string;
  color: string;
  /** The cell to highlight (editing cell takes precedence over selection). */
  cell: PresenceCell;
  /** True when the collaborator is actively editing `cell`, not just selecting. */
  editing: boolean;
}

/**
 * Shape of a single awareness state as written by `CsvBinding`. Kept loose
 * because awareness states are opaque `Record<string, unknown>` on the wire.
 */
interface RawAwarenessState {
  user?: { id?: unknown; name?: unknown; color?: unknown };
  selectedCell?: unknown;
  editingCell?: unknown;
}

function toCell(value: unknown): PresenceCell | null {
  if (!value || typeof value !== 'object') return null;
  const { row, col } = value as { row?: unknown; col?: unknown };
  if (typeof row !== 'number' || typeof col !== 'number') return null;
  if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0) return null;
  return { row, col };
}

/**
 * Reduce raw awareness states into a render-ready presence list.
 *
 * - Skips the local client (`localClientId`).
 * - Skips states without a usable `user.id` or without any cell.
 * - Prefers `editingCell` over `selectedCell` and flags `editing` accordingly.
 *
 * Fail-soft: a malformed collaborator is dropped, never thrown -- this is
 * presence chrome, not document data.
 */
export function extractRemotePresences(
  states: Map<number, RawAwarenessState>,
  localClientId: number,
): RemotePresence[] {
  const out: RemotePresence[] = [];
  for (const [clientId, state] of states) {
    if (clientId === localClientId) continue;
    if (!state || typeof state !== 'object') continue;

    const user = state.user;
    const userId = user && typeof user.id === 'string' ? user.id : null;
    if (!userId) continue;

    const editingCell = toCell(state.editingCell);
    const selectedCell = toCell(state.selectedCell);
    const cell = editingCell ?? selectedCell;
    if (!cell) continue;

    const name =
      user && typeof user.name === 'string' && user.name.trim() ? user.name : 'Collaborator';
    const color =
      user && typeof user.color === 'string' && user.color ? user.color : '#888888';

    out.push({ userId, name, color, cell, editing: editingCell !== null });
  }
  return out;
}

/** Which RevoGrid row section a logical row lives in, and its in-section index. */
export interface CellSection {
  /** RevoGrid `revogr-data[type]` value. */
  rowType: 'rowPinStart' | 'rgRow';
  /** Row index within that section (matches the cell's `data-rgRow`). */
  gridRow: number;
}

/**
 * Map a logical row index (as stored in awareness) to the RevoGrid section it
 * renders in. Header rows (`row < headerRowCount`) are pinned to the top in a
 * separate `revogr-data[type="rowPinStart"]` whose `data-rgRow` restarts at 0;
 * data rows live in the scrolling `type="rgRow"` section offset by the header
 * count. Mirrors `translateRowIndex` in SpreadsheetEditor.
 */
export function resolveCellSection(row: number, headerRowCount: number): CellSection {
  if (row < headerRowCount) {
    return { rowType: 'rowPinStart', gridRow: row };
  }
  return { rowType: 'rgRow', gridRow: row - headerRowCount };
}
