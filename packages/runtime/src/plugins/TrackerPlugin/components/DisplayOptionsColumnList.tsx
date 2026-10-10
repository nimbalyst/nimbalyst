/**
 * The column-property half of Display Settings: which columns are visible, in
 * which order (drag-reorderable), and which are hidden. Split out of
 * DisplayOptionsPanel so the panel itself stays a layout of view settings.
 */

import React, { useCallback, useState } from 'react';
import type { TrackerColumnDef, TypeColumnConfig } from './trackerColumns';

interface DisplayOptionsColumnListProps {
  availableColumns: TrackerColumnDef[];
  config: TypeColumnConfig;
  onConfigChange: (config: TypeColumnConfig) => void;
}

export const DisplayOptionsColumnList: React.FC<DisplayOptionsColumnListProps> = ({
  availableColumns,
  config,
  onConfigChange,
}) => {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const toggleColumn = useCallback((columnId: string) => {
    const visible = [...config.visibleColumns];
    const idx = visible.indexOf(columnId);
    if (idx >= 0) {
      // Don't allow removing title column
      if (columnId === 'title') return;
      visible.splice(idx, 1);
    } else {
      visible.push(columnId);
    }
    onConfigChange({ ...config, visibleColumns: visible });
  }, [config, onConfigChange]);

  const handleDragStart = useCallback((e: React.DragEvent, columnId: string) => {
    setDraggedId(columnId);
    e.dataTransfer.effectAllowed = 'move';
    // Set drag image to be semi-transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(columnId);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    const visible = [...config.visibleColumns];
    const fromIdx = visible.indexOf(draggedId);
    const toIdx = visible.indexOf(targetId);

    if (fromIdx >= 0 && toIdx >= 0) {
      visible.splice(fromIdx, 1);
      visible.splice(toIdx, 0, draggedId);
      onConfigChange({ ...config, visibleColumns: visible });
    }

    setDraggedId(null);
    setDragOverId(null);
  }, [draggedId, config, onConfigChange]);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  const visibleColumns = config.visibleColumns
    .map(id => availableColumns.find(c => c.id === id))
    .filter((c): c is TrackerColumnDef => c !== undefined);

  const hiddenColumns = availableColumns.filter(
    c => !config.visibleColumns.includes(c.id)
  );

  return (
    <div className="display-options-column-list" data-testid="tracker-display-options-columns">
      {/* Visible columns (drag-reorderable) */}
      <div className="px-3 py-2 border-b border-[var(--nim-border)]">
        <span className="text-[11px] font-medium text-[var(--nim-text-faint)] uppercase tracking-wide">Display properties</span>
        <div className="mt-1.5 space-y-0.5">
          {visibleColumns.map(col => (
            <div
              key={col.id}
              draggable={col.id !== 'title'}
              onDragStart={(e) => handleDragStart(e, col.id)}
              onDragOver={(e) => handleDragOver(e, col.id)}
              onDrop={(e) => handleDrop(e, col.id)}
              onDragEnd={handleDragEnd}
              className={`flex items-center gap-2 px-1.5 py-1 rounded text-xs cursor-grab ${
                dragOverId === col.id ? 'bg-[var(--nim-primary)]15 border border-dashed border-[var(--nim-primary)]' : 'hover:bg-[var(--nim-bg-hover)]'
              } ${draggedId === col.id ? 'opacity-50' : ''}`}
            >
              {col.id !== 'title' && (
                <button type="button" aria-label={`Reorder ${col.label}`} title="Drag or use the arrow keys to reorder" className="text-[var(--nim-text-faint)] cursor-grab" onKeyDown={event => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  const visible = [...config.visibleColumns];
                  const from = visible.indexOf(col.id);
                  const to = from + (event.key === 'ArrowUp' ? -1 : 1);
                  if (to < 0 || to >= visible.length) return;
                  [visible[from], visible[to]] = [visible[to], visible[from]];
                  onConfigChange({ ...config, visibleColumns: visible });
                }}><span className="material-symbols-outlined text-[14px]" aria-hidden>drag_indicator</span></button>
              )}
              <span className="flex-1 text-[var(--nim-text)]">{col.label}</span>
              {col.id !== 'title' && (
                <button
                  type="button"
                  aria-label={`Hide ${col.label}`}
                  onClick={() => toggleColumn(col.id)}
                  className="text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] transition-colors"
                  title="Hide column"
                >
                  <span className="material-symbols-outlined text-[14px]">visibility</span>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Hidden columns */}
      {hiddenColumns.length > 0 && (
        <div className="px-3 py-2">
          <span className="text-[11px] font-medium text-[var(--nim-text-faint)] uppercase tracking-wide">Hidden</span>
          <div className="mt-1.5 space-y-0.5">
            {hiddenColumns.map(col => (
              <button
                key={col.id}
                type="button"
                aria-label={`Show ${col.label}`}
                className="flex w-full items-center gap-2 px-1.5 py-1 rounded text-left text-xs hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={() => toggleColumn(col.id)}
              >
                <span className="material-symbols-outlined text-[14px] text-[var(--nim-text-faint)]">visibility_off</span>
                <span className="flex-1 text-[var(--nim-text-faint)]">{col.label}</span>
                <span className="text-[10px] text-[var(--nim-primary)]">Show</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
