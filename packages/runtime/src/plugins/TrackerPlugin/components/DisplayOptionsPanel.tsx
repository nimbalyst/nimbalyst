/**
 * DisplayOptionsPanel -- dropdown panel for configuring visible columns,
 * column order (drag-reorderable), and grouping options.
 * Modeled after Linear's display options panel.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react';
import { windowControlsClearance } from '../../../ui/floating/windowControlsClearance';
import type { TrackerColumnDef, TypeColumnConfig } from './trackerColumns';

interface DisplayOptionsPanelProps {
  /** All available columns for this type */
  availableColumns: TrackerColumnDef[];
  /** Current column config */
  config: TypeColumnConfig;
  /** Called when config changes */
  onConfigChange: (config: TypeColumnConfig) => void;
  /** Close the panel */
  onClose: () => void;
  /** Optional trigger element for viewport-aware floating positioning */
  anchorElement?: HTMLElement | null;
}

export const DisplayOptionsPanel: React.FC<DisplayOptionsPanelProps> = ({
  availableColumns,
  config,
  onConfigChange,
  onClose,
  anchorElement,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const isFloating = Boolean(anchorElement);
  const { refs, floatingStyles } = useFloating({
    open: isFloating,
    placement: 'bottom-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      windowControlsClearance(),
      size({
        padding: 8,
        apply({ availableHeight, elements, middlewareData }) {
          const pushed = middlewareData.windowControlsClearance?.pushed ?? 0;
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight - pushed)}px`;
        },
      }),
    ],
  });

  useEffect(() => {
    if (anchorElement) refs.setReference(anchorElement);
  }, [anchorElement, refs]);

  const setPanelElement = useCallback((element: HTMLDivElement | null) => {
    panelRef.current = element;
    if (isFloating) refs.setFloating(element);
  }, [isFloating, refs]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        panelRef.current
        && !panelRef.current.contains(target)
        && !anchorElement?.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [anchorElement, onClose]);

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

  // Separate visible and hidden columns
  const visibleColumns = config.visibleColumns
    .map(id => availableColumns.find(c => c.id === id))
    .filter((c): c is TrackerColumnDef => c !== undefined);

  const hiddenColumns = availableColumns.filter(
    c => !config.visibleColumns.includes(c.id)
  );

  // Grouping options
  const groupByOptions = [
    { value: '', label: 'No grouping' },
    { value: 'status', label: 'Status' },
    { value: 'priority', label: 'Priority' },
    { value: 'type', label: 'Type' },
    { value: 'owner', label: 'Owner' },
  ];

  const panel = (
    <div
      ref={setPanelElement}
      style={isFloating ? floatingStyles : undefined}
      data-testid="tracker-display-options-panel"
      className={`${isFloating ? '' : 'absolute right-0 top-full mt-1 max-h-[calc(100vh-4rem)]'} flex w-[260px] flex-col overflow-hidden rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-xl z-50`}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-[var(--nim-border)]">
        <span className="text-xs font-semibold text-[var(--nim-text)]">Display Options</span>
      </div>

      {/* Grouping */}
      <div className="px-3 py-2 border-b border-[var(--nim-border)]">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-[var(--nim-text-muted)]">Grouping</span>
          <select
            value={config.groupBy || ''}
            onChange={(e) => onConfigChange({ ...config, groupBy: e.target.value || null })}
            aria-label="Group tracker items"
            className="text-xs bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded px-1.5 py-0.5 text-[var(--nim-text)] outline-none"
          >
            {groupByOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div
        className="min-h-0 overflow-y-auto overscroll-contain"
        data-testid="tracker-display-options-scroll-region"
      >
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
                  <span className="material-symbols-outlined text-[14px] text-[var(--nim-text-faint)] cursor-grab">drag_indicator</span>
                )}
                <span className="flex-1 text-[var(--nim-text)]">{col.label}</span>
                {col.id !== 'title' && (
                  <button
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
                <div
                  key={col.id}
                  className="flex items-center gap-2 px-1.5 py-1 rounded text-xs hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                  onClick={() => toggleColumn(col.id)}
                >
                  <span className="material-symbols-outlined text-[14px] text-[var(--nim-text-faint)]">visibility_off</span>
                  <span className="flex-1 text-[var(--nim-text-faint)]">{col.label}</span>
                  <span className="text-[10px] text-[var(--nim-primary)]">Show</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Reset */}
      <div className="px-3 py-2 border-t border-[var(--nim-border)]">
        <button
          className="text-xs text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] transition-colors"
          onClick={() => {
            const defaults = availableColumns.filter(c => c.defaultVisible).map(c => c.id);
            onConfigChange({ visibleColumns: defaults, columnWidths: {}, groupBy: null });
          }}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );

  return isFloating ? <FloatingPortal>{panel}</FloatingPortal> : panel;
};
