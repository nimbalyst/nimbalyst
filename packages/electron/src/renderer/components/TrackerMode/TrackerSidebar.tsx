import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AddFolderModal } from './AddFolderModal';
import { TrackerTypeCreator } from '../Settings/panels/TrackerTypeCreator';
import { useAtomValue } from 'jotai';
import { MaterialSymbol, globalRegistry } from '@nimbalyst/runtime';
import type { TrackerItemType } from '@nimbalyst/runtime';
import { trackerItemCountByTypeAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { TrackerFilterChip } from '../../store/atoms/trackers';
import type { ViewMode } from './TrackerMainView';
import { WorkspaceSummaryHeader } from '../WorkspaceSummaryHeader';
import { AlphaBadge } from '../common/AlphaBadge';
import {
  loadLayout,
  saveLayout,
  loadLegacyState,
  buildLayoutFromLegacy,
  reconcileLayout,
  moveEntry,
  setFolderCollapsed,
  addFolder,
  EMPTY_LAYOUT,
  type TrackerSidebarLayout,
  type SidebarEntry,
  type DragLocation,
  type DropLocation,
} from '../../services/TrackerSidebarLayout';
import { readDragPayload, TRACKER_ITEM_DND_MIME, type DraggedTrackerItem } from './trackerItemDnd';

const FOLDER_REORDER_MIME = 'application/x-nimbalyst-tracker-folder-reorder';
const TYPE_REORDER_MIME = 'application/x-nimbalyst-tracker-type-reorder';

interface TrackerSidebarProps {
  workspacePath?: string;
  workspaceName?: string;
  trackerTypes: TrackerDataModel[];
  selectedType: string | 'all';
  activeFilters: TrackerFilterChip[];
  viewMode: ViewMode;
  onSelectType: (type: string | 'all') => void;
  onToggleFilter: (filter: TrackerFilterChip) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onItemMove?: (payload: DraggedTrackerItem, targetType: string) => void;
}

const FILTER_CHIPS: { id: TrackerFilterChip; label: string; icon: string }[] = [
  { id: 'mine', label: 'Mine', icon: 'person' },
  { id: 'unassigned', label: 'Unassigned', icon: 'person_off' },
  { id: 'high-priority', label: 'High Priority', icon: 'priority_high' },
  { id: 'recently-updated', label: 'Recent', icon: 'schedule' },
  { id: 'archived', label: 'Archived', icon: 'archive' },
];

function SidebarTypeCount({ type }: { type: TrackerItemType }) {
  const count = useAtomValue(trackerItemCountByTypeAtom(type));
  return <>{count}</>;
}

// ============================================================================
// Drop indicator state
// ============================================================================

interface DropIndicator {
  position: 'before' | 'after' | 'inside';
  target: number[];
}

// ============================================================================
// TrackerTypeButton (with both item-drop and reorder-drop support)
// ============================================================================

function TrackerTypeButton({
  tracker,
  selectedType,
  onSelect,
  onItemDrop,
  draggable,
  onDragStart,
  dropIndicator,
  onReorderDragOver,
  onReorderDrop,
  onDragLeave,
}: {
  tracker: TrackerDataModel;
  selectedType: string | 'all';
  onSelect: (type: string | 'all') => void;
  onItemDrop?: (payload: DraggedTrackerItem, targetType: string) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  dropIndicator?: DropIndicator | null;
  onReorderDragOver?: (e: React.DragEvent) => void;
  onReorderDrop?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
}) {
  const [isItemDropHover, setIsItemDropHover] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(TRACKER_ITEM_DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setIsItemDropHover(true);
    } else if (
      e.dataTransfer.types.includes(FOLDER_REORDER_MIME) ||
      e.dataTransfer.types.includes(TYPE_REORDER_MIME)
    ) {
      onReorderDragOver?.(e);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(TRACKER_ITEM_DND_MIME)) {
      e.preventDefault();
      setIsItemDropHover(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsItemDropHover(false);
    }
    onDragLeave?.(e);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(TRACKER_ITEM_DND_MIME)) {
      e.preventDefault();
      setIsItemDropHover(false);
      const payload = readDragPayload(e);
      if (!payload) return;
      if (payload.primaryType === tracker.type) return;
      onItemDrop?.(payload, tracker.type);
    } else {
      onReorderDrop?.(e);
    }
  };

  const showBefore = dropIndicator?.position === 'before';
  const showAfter = dropIndicator?.position === 'after';

  return (
    <div className="relative">
      {showBefore && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-[var(--nim-primary)] z-10 pointer-events-none" />
      )}
      <button
        key={tracker.type}
        data-testid="tracker-type-button"
        data-tracker-type={tracker.type}
        draggable={draggable}
        onDragStart={onDragStart}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors cursor-grab active:cursor-grabbing ${
          selectedType === tracker.type
            ? 'bg-nim-active text-nim'
            : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
        } ${isItemDropHover ? 'ring-2 ring-[var(--nim-primary)] bg-[var(--nim-bg-tertiary)]' : ''}`}
        onClick={() => onSelect(tracker.type)}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span style={{ color: tracker.color }}>
          <MaterialSymbol icon={tracker.icon} size={16} />
        </span>
        <span className="flex-1 text-left truncate">{tracker.displayNamePlural}</span>
        <span className="text-[10px] font-semibold text-nim-faint min-w-[20px] text-right">
          <SidebarTypeCount type={tracker.type as TrackerItemType} />
        </span>
      </button>
      {showAfter && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--nim-primary)] z-10 pointer-events-none" />
      )}
    </div>
  );
}

// ============================================================================
// Main sidebar
// ============================================================================

export const TrackerSidebar: React.FC<TrackerSidebarProps> = ({
  workspacePath,
  workspaceName,
  trackerTypes,
  selectedType,
  activeFilters,
  viewMode,
  onSelectType,
  onToggleFilter,
  onViewModeChange,
  onItemMove,
}) => {
  const [layout, setLayout] = useState<TrackerSidebarLayout>(EMPTY_LAYOUT);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const layoutRef = useRef<TrackerSidebarLayout>(EMPTY_LAYOUT);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addFolderOpen, setAddFolderOpen] = useState(false);
  const [addTypeOpen, setAddTypeOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  const updateLayout = useCallback((next: TrackerSidebarLayout) => {
    layoutRef.current = next;
    setLayout(next);
  }, []);

  const loadAndReconcile = useCallback(async (models: TrackerDataModel[]) => {
    if (!workspacePath) return;
    let saved = await loadLayout(workspacePath);
    if (saved.entries.length === 0) {
      const legacy = await loadLegacyState(workspacePath);
      saved = buildLayoutFromLegacy(models, legacy.folders, legacy.overrides);
    }
    const reconciled = reconcileLayout(saved, models);
    updateLayout(reconciled);
    const hasChanges =
      JSON.stringify(reconciled.entries) !== JSON.stringify(saved.entries);
    if (hasChanges) {
      await saveLayout(workspacePath, reconciled);
    }
  }, [workspacePath, updateLayout]);

  useEffect(() => {
    if (!workspacePath) return;
    loadAndReconcile(trackerTypes);

    const unsubscribe = globalRegistry.onChange(() => {
      loadAndReconcile(globalRegistry.getAll());
    });

    return () => {
      unsubscribe();
    };
  }, [workspacePath, loadAndReconcile, trackerTypes]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [addMenuOpen]);

  // ============================================================================
  // Drag/drop helpers
  // ============================================================================

  const computeDropPosition = (
    e: React.DragEvent,
    isFolder: boolean
  ): 'before' | 'after' | 'inside' => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const third = rect.height / 3;
    if (relY < third) return 'before';
    if (relY > third * 2 && isFolder) return 'inside';
    return 'after';
  };

  const handleFolderToggle = useCallback(async (folderName: string, currentCollapsed: boolean) => {
    if (!workspacePath) return;
    const next = setFolderCollapsed(layoutRef.current, folderName, !currentCollapsed);
    updateLayout(next);
    await saveLayout(workspacePath, next);
  }, [workspacePath, updateLayout]);

  // ============================================================================
  // Reorder drag handlers — top-level entries
  // ============================================================================

  const handleTopLevelDragStart = (
    e: React.DragEvent,
    entry: SidebarEntry,
    entryIdx: number
  ) => {
    if (entry.kind === 'folder') {
      e.dataTransfer.setData(FOLDER_REORDER_MIME, JSON.stringify({ name: entry.name }));
    } else {
      e.dataTransfer.setData(
        TYPE_REORDER_MIME,
        JSON.stringify({ typeId: entry.typeId, fromFolder: null })
      );
    }
    e.dataTransfer.effectAllowed = 'move';
    // Store origin index for computing drop target after removal
    e.dataTransfer.setData('text/plain', String(entryIdx));
  };

  const handleTopLevelDragOver = (
    e: React.DragEvent,
    entryIdx: number,
    isFolder: boolean
  ) => {
    const isReorder =
      e.dataTransfer.types.includes(FOLDER_REORDER_MIME) ||
      e.dataTransfer.types.includes(TYPE_REORDER_MIME);
    if (!isReorder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const pos = computeDropPosition(e, isFolder);
    setDropIndicator({ position: pos, target: [entryIdx] });
  };

  const handleTopLevelDrop = useCallback(async (e: React.DragEvent, entryIdx: number) => {
    e.preventDefault();
    const isFolder = e.dataTransfer.types.includes(FOLDER_REORDER_MIME);
    const isType = e.dataTransfer.types.includes(TYPE_REORDER_MIME);
    if (!isFolder && !isType) return;

    const pos = computeDropPosition(e, !isType);
    const drop: DropLocation = { position: pos, target: [entryIdx] };
    let drag: DragLocation;

    if (isFolder) {
      const data = JSON.parse(e.dataTransfer.getData(FOLDER_REORDER_MIME));
      drag = { kind: 'folder', id: data.name };
    } else {
      const data = JSON.parse(e.dataTransfer.getData(TYPE_REORDER_MIME));
      drag = { kind: 'type', id: data.typeId, fromFolder: data.fromFolder };
    }

    const next = moveEntry(layoutRef.current, drag, drop);
    updateLayout(next);
    setDropIndicator(null);
    if (workspacePath) await saveLayout(workspacePath, next);
  }, [workspacePath, updateLayout]);

  // ============================================================================
  // Reorder drag handlers — types inside a folder
  // ============================================================================

  const handleInFolderTypeDragStart = (
    e: React.DragEvent,
    typeId: string,
    folderName: string
  ) => {
    e.stopPropagation();
    e.dataTransfer.setData(
      TYPE_REORDER_MIME,
      JSON.stringify({ typeId, fromFolder: folderName })
    );
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleInFolderTypeDragOver = (
    e: React.DragEvent,
    folderIdx: number,
    typeIdx: number
  ) => {
    const isReorder =
      e.dataTransfer.types.includes(FOLDER_REORDER_MIME) ||
      e.dataTransfer.types.includes(TYPE_REORDER_MIME);
    if (!isReorder) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const pos = computeDropPosition(e, false);
    setDropIndicator({ position: pos, target: [folderIdx, typeIdx] });
  };

  const handleInFolderTypeDrop = useCallback(async (
    e: React.DragEvent,
    folderIdx: number,
    typeIdx: number
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const isFolder = e.dataTransfer.types.includes(FOLDER_REORDER_MIME);
    const isType = e.dataTransfer.types.includes(TYPE_REORDER_MIME);
    if (!isFolder && !isType) return;

    const pos = computeDropPosition(e, false);
    const drop: DropLocation = { position: pos, target: [folderIdx, typeIdx] };
    let drag: DragLocation;

    if (isFolder) {
      const data = JSON.parse(e.dataTransfer.getData(FOLDER_REORDER_MIME));
      drag = { kind: 'folder', id: data.name };
    } else {
      const data = JSON.parse(e.dataTransfer.getData(TYPE_REORDER_MIME));
      drag = { kind: 'type', id: data.typeId, fromFolder: data.fromFolder };
    }

    const next = moveEntry(layoutRef.current, drag, drop);
    updateLayout(next);
    setDropIndicator(null);
    if (workspacePath) await saveLayout(workspacePath, next);
  }, [workspacePath, updateLayout]);

  const handleFolderHeaderDragOver = (
    e: React.DragEvent,
    folderIdx: number
  ) => {
    const isReorder =
      e.dataTransfer.types.includes(FOLDER_REORDER_MIME) ||
      e.dataTransfer.types.includes(TYPE_REORDER_MIME);
    if (!isReorder) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const pos = computeDropPosition(e, true);
    setDropIndicator({ position: pos, target: [folderIdx] });
  };

  const handleFolderHeaderDrop = useCallback(async (
    e: React.DragEvent,
    folderIdx: number
  ) => {
    e.preventDefault();
    const isFolder = e.dataTransfer.types.includes(FOLDER_REORDER_MIME);
    const isType = e.dataTransfer.types.includes(TYPE_REORDER_MIME);
    if (!isFolder && !isType) return;

    const pos = computeDropPosition(e, true);
    const drop: DropLocation = { position: pos, target: [folderIdx] };
    let drag: DragLocation;

    if (isFolder) {
      const data = JSON.parse(e.dataTransfer.getData(FOLDER_REORDER_MIME));
      drag = { kind: 'folder', id: data.name };
    } else {
      const data = JSON.parse(e.dataTransfer.getData(TYPE_REORDER_MIME));
      drag = { kind: 'type', id: data.typeId, fromFolder: data.fromFolder };
    }

    const next = moveEntry(layoutRef.current, drag, drop);
    updateLayout(next);
    setDropIndicator(null);
    if (workspacePath) await saveLayout(workspacePath, next);
  }, [workspacePath, updateLayout]);

  const handleDragEnd = () => {
    setDropIndicator(null);
  };

  // ============================================================================
  // Render
  // ============================================================================

  const modelMap = new Map(trackerTypes.map((m) => [m.type, m]));

  return (
    <div
      className="tracker-sidebar w-full h-full flex flex-col bg-nim-secondary overflow-hidden"
      data-testid="tracker-sidebar"
    >
      {workspacePath && (
        <WorkspaceSummaryHeader
          workspacePath={workspacePath}
          workspaceName={workspaceName}
          actions={
            <>
              <div className="flex items-center rounded border border-nim overflow-hidden">
                <button
                  className={`flex items-center justify-center w-7 h-6 transition-colors ${
                    viewMode === 'table'
                      ? 'bg-nim-active text-nim'
                      : 'bg-nim-secondary text-nim-muted hover:text-nim'
                  }`}
                  onClick={() => onViewModeChange('table')}
                  title="Table view"
                >
                  <MaterialSymbol icon="table_rows" size={16} />
                </button>
                <button
                  className={`relative flex items-center justify-center w-7 h-6 border-l border-nim transition-colors ${
                    viewMode === 'kanban'
                      ? 'bg-nim-active text-nim'
                      : 'bg-nim-secondary text-nim-muted hover:text-nim'
                  }`}
                  onClick={() => onViewModeChange('kanban')}
                  title="Kanban view (alpha)"
                >
                  <MaterialSymbol icon="view_kanban" size={16} />
                  <AlphaBadge size="dot" className="absolute -top-1 -right-1 pointer-events-none" />
                </button>
              </div>
            </>
          }
        />
      )}

      <div className="px-3 py-1.5 border-b border-nim flex items-center justify-between">
        <span className="text-[11px] font-semibold text-nim-muted uppercase tracking-wider">
          Trackers
        </span>
        <div className="relative" ref={addMenuRef}>
          <button
            onClick={() => setAddMenuOpen((v) => !v)}
            className="w-5 h-5 flex items-center justify-center rounded text-nim-muted hover:text-nim hover:bg-nim-tertiary cursor-pointer transition-colors"
            title="Add tracker type or folder"
            data-testid="tracker-sidebar-add"
          >
            <MaterialSymbol icon="add" size={14} />
          </button>
          {addMenuOpen && (
            <div className="absolute right-0 top-full mt-1 z-20 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-lg py-1 min-w-[160px]">
              <button
                onClick={() => { setAddMenuOpen(false); setAddFolderOpen(true); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-nim hover:bg-nim-tertiary cursor-pointer text-left"
              >
                <MaterialSymbol icon="folder" size={14} />
                Add Folder
              </button>
              <button
                onClick={() => { setAddMenuOpen(false); setAddTypeOpen(true); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-nim hover:bg-nim-tertiary cursor-pointer text-left"
              >
                <MaterialSymbol icon="add_circle" size={14} />
                Add Tracker Type
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Filter chips */}
        <div className="px-2 pt-2 pb-1">
          <div className="text-[10px] font-semibold text-nim-faint uppercase tracking-wider px-1 mb-1.5">
            Filters
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTER_CHIPS.map((chip) => {
              const isActive = activeFilters.includes(chip.id);
              return (
                <button
                  key={chip.id}
                  data-testid={`tracker-filter-${chip.id}`}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    isActive
                      ? 'bg-[var(--nim-primary)] text-white'
                      : 'bg-nim-tertiary text-nim-muted hover:bg-nim-active hover:text-nim'
                  }`}
                  onClick={() => onToggleFilter(chip.id)}
                >
                  <MaterialSymbol icon={chip.icon} size={13} />
                  {chip.label}
                </button>
              );
            })}
          </div>
          {activeFilters.length > 0 && (
            <button
              className="mt-1 px-1 text-[10px] text-nim-faint hover:text-nim-muted transition-colors"
              onClick={() => activeFilters.forEach((f) => onToggleFilter(f))}
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Types Section */}
        <div className="px-1.5 py-2 border-t border-nim mt-1">
          <div className="text-[10px] font-semibold text-nim-faint uppercase tracking-wider px-2 mb-1">
            Types
          </div>

          {/* All */}
          <button
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
              selectedType === 'all'
                ? 'bg-nim-active text-nim'
                : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
            }`}
            onClick={() => onSelectType('all')}
          >
            <MaterialSymbol icon="checklist" size={16} />
            <span className="flex-1 text-left truncate">All</span>
          </button>

          {/* Layout-based entries */}
          {layout.entries.map((entry, entryIdx) => {
            if (entry.kind === 'type') {
              const tracker = modelMap.get(entry.typeId);
              if (!tracker) return null;

              const indicator =
                dropIndicator?.target.length === 1 &&
                dropIndicator.target[0] === entryIdx
                  ? dropIndicator
                  : null;

              return (
                <TrackerTypeButton
                  key={tracker.type}
                  tracker={tracker}
                  selectedType={selectedType}
                  onSelect={onSelectType}
                  onItemDrop={onItemMove}
                  draggable
                  onDragStart={(e) => handleTopLevelDragStart(e, entry, entryIdx)}
                  dropIndicator={indicator}
                  onReorderDragOver={(e) => handleTopLevelDragOver(e, entryIdx, false)}
                  onReorderDrop={(e) => handleTopLevelDrop(e, entryIdx)}
                  onDragLeave={() => setDropIndicator(null)}
                />
              );
            }

            // Folder entry
            const isCollapsed = entry.collapsed === true;
            const folderTypes = entry.types
              .map((t) => modelMap.get(t))
              .filter((m): m is TrackerDataModel => m != null);

            const isInsideTarget =
              dropIndicator?.position === 'inside' &&
              dropIndicator.target.length === 1 &&
              dropIndicator.target[0] === entryIdx;

            const folderHeaderIndicator =
              dropIndicator?.target.length === 1 &&
              dropIndicator.target[0] === entryIdx &&
              dropIndicator.position !== 'inside'
                ? dropIndicator
                : null;

            return (
              <div
                key={entry.name}
                className="flex flex-col"
                onDragEnd={handleDragEnd}
              >
                {/* Folder header */}
                <div className="relative">
                  {folderHeaderIndicator?.position === 'before' && (
                    <div className="absolute top-0 left-0 right-0 h-[2px] bg-[var(--nim-primary)] z-10 pointer-events-none" />
                  )}
                  <div
                    draggable
                    onDragStart={(e) => handleTopLevelDragStart(e, entry, entryIdx)}
                    onDragOver={(e) => handleFolderHeaderDragOver(e, entryIdx)}
                    onDrop={(e) => handleFolderHeaderDrop(e, entryIdx)}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDropIndicator(null);
                      }
                    }}
                    className={`cursor-grab active:cursor-grabbing ${
                      isInsideTarget ? 'ring-2 ring-[var(--nim-primary)] rounded-md' : ''
                    }`}
                  >
                    <button
                      onClick={() => handleFolderToggle(entry.name, isCollapsed)}
                      className="w-full flex items-center gap-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-nim-faint hover:text-nim-muted transition-colors"
                    >
                      <MaterialSymbol
                        icon={isCollapsed ? 'chevron_right' : 'expand_more'}
                        size={14}
                      />
                      <span className="flex-1 text-left truncate">{entry.name}</span>
                      <span className="text-[10px] text-nim-faint">{folderTypes.length}</span>
                    </button>
                  </div>
                  {folderHeaderIndicator?.position === 'after' && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--nim-primary)] z-10 pointer-events-none" />
                  )}
                </div>

                {/* Folder contents */}
                {!isCollapsed && (
                  <div className="flex flex-col pl-2.5">
                    {folderTypes.map((tracker, typeIdx) => {
                      const indicator =
                        dropIndicator?.target.length === 2 &&
                        dropIndicator.target[0] === entryIdx &&
                        dropIndicator.target[1] === typeIdx
                          ? dropIndicator
                          : null;

                      return (
                        <TrackerTypeButton
                          key={tracker.type}
                          tracker={tracker}
                          selectedType={selectedType}
                          onSelect={onSelectType}
                          onItemDrop={onItemMove}
                          draggable
                          onDragStart={(e) =>
                            handleInFolderTypeDragStart(e, tracker.type, entry.name)
                          }
                          dropIndicator={indicator}
                          onReorderDragOver={(e) =>
                            handleInFolderTypeDragOver(e, entryIdx, typeIdx)
                          }
                          onReorderDrop={(e) =>
                            handleInFolderTypeDrop(e, entryIdx, typeIdx)
                          }
                          onDragLeave={() => setDropIndicator(null)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {addFolderOpen && (
        <AddFolderModal
          existingFolderNames={layout.entries
            .filter((e): e is Extract<SidebarEntry, { kind: 'folder' }> => e.kind === 'folder')
            .map((e) => e.name)}
          onCancel={() => setAddFolderOpen(false)}
          onConfirm={async (name) => {
            const next = addFolder(layout, name);
            updateLayout(next);
            if (workspacePath) await saveLayout(workspacePath, next);
            setAddFolderOpen(false);
          }}
        />
      )}
      {addTypeOpen && workspacePath && (
        <TrackerTypeCreator
          workspacePath={workspacePath}
          onClose={() => setAddTypeOpen(false)}
          onCreated={() => setAddTypeOpen(false)}
        />
      )}
    </div>
  );
};
