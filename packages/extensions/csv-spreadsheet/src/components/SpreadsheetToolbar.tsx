/**
 * SpreadsheetToolbar Component
 *
 * Toolbar with actions for manipulating the spreadsheet data.
 */

import type { SortConfig } from '../types';

interface SpreadsheetToolbarProps {
  onAddRow: () => void;
  onDeleteRow: () => void;
  onAddColumn: () => void;
  onDeleteColumn: () => void;
  onSortAsc: () => void;
  onSortDesc: () => void;
  onToggleHeaders: () => void;
  hasSelection: boolean;
  hasHeaders: boolean;
  sortConfig: SortConfig | null;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export function SpreadsheetToolbar({
  onAddRow,
  onDeleteRow,
  onAddColumn,
  onDeleteColumn,
  onSortAsc,
  onSortDesc,
  onToggleHeaders,
  hasSelection,
  hasHeaders,
  sortConfig,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: SpreadsheetToolbarProps) {
  return (
    <div className="flex items-center gap-2 bg-nim-secondary border-b border-nim">
      <div className="flex gap-1">
        <button
          className="px-3 py-1.5 text-[13px] font-medium bg-nim-secondary border border-nim rounded text-nim cursor-pointer transition-all hover:bg-nim-hover active:bg-nim-tertiary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Cmd+Z)"
        >
          Undo
        </button>
        <button
          className="px-3 py-1.5 text-[13px] font-medium bg-nim-secondary border border-nim rounded text-nim cursor-pointer transition-all hover:bg-nim-hover active:bg-nim-tertiary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Cmd+Shift+Z)"
        >
          Redo
        </button>
      </div>

      <div className="w-px h-6 bg-[var(--nim-border)] mx-2" />

      <div className="flex gap-1">
        <button
          className={`px-3 py-1.5 text-[13px] font-medium border rounded cursor-pointer transition-all ${hasHeaders ? 'bg-[var(--nim-primary)] text-white border-[var(--nim-primary)]' : 'bg-nim-secondary text-nim border-nim hover:bg-nim-hover active:bg-nim-tertiary'} disabled:opacity-50 disabled:cursor-not-allowed`}
          onClick={onToggleHeaders}
          title={hasHeaders ? 'First row is header (click to toggle)' : 'Treat first row as header'}
        >
          Header Row
        </button>
      </div>

      <div className="w-px h-6 bg-[var(--nim-border)] mx-2" />

      <div className="flex gap-1">
        <button
          className="px-3 py-1.5 text-[13px] font-medium bg-nim-secondary border border-nim rounded text-nim cursor-pointer transition-all hover:bg-nim-hover active:bg-nim-tertiary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onAddRow}
          title="Add Row"
        >
          + Row
        </button>
        <button
          className="px-3 py-1.5 text-[13px] font-medium bg-nim-secondary border border-nim rounded text-nim cursor-pointer transition-all hover:bg-nim-hover active:bg-nim-tertiary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onDeleteRow}
          disabled={!hasSelection}
          title="Delete Row"
        >
          - Row
        </button>
      </div>

      <div className="w-px h-6 bg-[var(--nim-border)] mx-2" />

      <div className="flex gap-1">
        <button
          className="px-3 py-1.5 text-[13px] font-medium bg-nim-secondary border border-nim rounded text-nim cursor-pointer transition-all hover:bg-nim-hover active:bg-nim-tertiary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onAddColumn}
          title="Add Column"
        >
          + Col
        </button>
        <button
          className="px-3 py-1.5 text-[13px] font-medium bg-nim-secondary border border-nim rounded text-nim cursor-pointer transition-all hover:bg-nim-hover active:bg-nim-tertiary disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onDeleteColumn}
          disabled={!hasSelection}
          title="Delete Column"
        >
          - Col
        </button>
      </div>

      <div className="w-px h-6 bg-[var(--nim-border)] mx-2" />

      <div className="flex gap-1">
        <button
          className={`px-3 py-1.5 text-[13px] font-medium border rounded cursor-pointer transition-all ${sortConfig?.direction === 'asc' ? 'bg-[var(--nim-primary)] text-white border-[var(--nim-primary)]' : 'bg-nim-secondary text-nim border-nim hover:bg-nim-hover active:bg-nim-tertiary'} disabled:opacity-50 disabled:cursor-not-allowed`}
          onClick={onSortAsc}
          disabled={!hasSelection}
          title="Sort Ascending"
        >
          A-Z
        </button>
        <button
          className={`px-3 py-1.5 text-[13px] font-medium border rounded cursor-pointer transition-all ${sortConfig?.direction === 'desc' ? 'bg-[var(--nim-primary)] text-white border-[var(--nim-primary)]' : 'bg-nim-secondary text-nim border-nim hover:bg-nim-hover active:bg-nim-tertiary'} disabled:opacity-50 disabled:cursor-not-allowed`}
          onClick={onSortDesc}
          disabled={!hasSelection}
          title="Sort Descending"
        >
          Z-A
        </button>
      </div>
    </div>
  );
}
