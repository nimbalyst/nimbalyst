import React, { useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerItemType } from '@nimbalyst/runtime';
import { trackerItemCountByTypeAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import type { TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { TrackerFilterChip } from '../../store/atoms/trackers';
import type { ViewMode } from './TrackerMainView';
import type { SavedView } from './trackerSavedViews';
import { WorkspaceSummaryHeader } from '../WorkspaceSummaryHeader';
import { AlphaBadge } from '../common/AlphaBadge';

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
  /** Saved views for this workspace (NIM-788). */
  savedViews: SavedView[];
  /** Apply a saved view's definition. */
  onApplyView: (view: SavedView) => void;
  /** Save the current view state under a name. */
  onSaveView: (name: string) => void;
  /** Delete a saved view by id. */
  onDeleteView: (viewId: string) => void;
}

const FILTER_CHIPS: { id: TrackerFilterChip; label: string; icon: string }[] = [
  { id: 'mine', label: 'Mine', icon: 'person' },
  { id: 'unassigned', label: 'Unassigned', icon: 'person_off' },
  { id: 'high-priority', label: 'High Priority', icon: 'priority_high' },
  { id: 'recently-updated', label: 'Recent', icon: 'schedule' },
  { id: 'archived', label: 'Archived', icon: 'archive' },
];

/** Small component so each sidebar row subscribes to its own atom */
function SidebarTypeCount({ type }: { type: TrackerItemType }) {
  const count = useAtomValue(trackerItemCountByTypeAtom(type));
  return <>{count}</>;
}

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
  savedViews,
  onApplyView,
  onSaveView,
  onDeleteView,
}) => {
  const [savingView, setSavingView] = useState(false);
  const [newViewName, setNewViewName] = useState('');

  const commitSaveView = () => {
    const name = newViewName.trim();
    if (!name) return;
    onSaveView(name);
    setNewViewName('');
    setSavingView(false);
  };

  return (
    <div className="tracker-sidebar w-full h-full flex flex-col bg-nim-secondary overflow-hidden" data-testid="tracker-sidebar">
      {workspacePath && (
        <WorkspaceSummaryHeader
          workspacePath={workspacePath}
          workspaceName={workspaceName}
          actions={
            <>
              <div className="flex items-center rounded border border-nim overflow-hidden">
                  <button
                    className={`flex items-center justify-center w-7 h-6 transition-colors ${
                      viewMode === 'list'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('list')}
                    title="List view"
                    data-testid="tracker-view-mode-list"
                  >
                    <MaterialSymbol icon="view_list" size={16} />
                  </button>
                  <button
                    className={`flex items-center justify-center w-7 h-6 border-l border-nim transition-colors ${
                      viewMode === 'table'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('table')}
                    title="Table view"
                    data-testid="tracker-view-mode-table"
                  >
                    <MaterialSymbol icon="table_chart" size={16} />
                  </button>
                  <button
                    className={`relative flex items-center justify-center w-7 h-6 border-l border-nim transition-colors ${
                      viewMode === 'kanban'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('kanban')}
                    title="Kanban view (alpha)"
                    data-testid="tracker-view-mode-kanban"
                  >
                    <MaterialSymbol icon="view_kanban" size={16} />
                    <AlphaBadge size="dot" className="absolute -top-1 -right-1 pointer-events-none" />
                  </button>
                  <button
                    className={`relative flex items-center justify-center w-7 h-6 border-l border-nim transition-colors ${
                      viewMode === 'tag-board'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('tag-board')}
                    title="Tag board view (alpha)"
                    data-testid="tracker-view-mode-tag-board"
                  >
                    <MaterialSymbol icon="sell" size={16} />
                    <AlphaBadge size="dot" className="absolute -top-1 -right-1 pointer-events-none" />
                  </button>
                </div>
            </>
          }
        />
      )}
      <div className="px-3 py-1.5 border-b border-nim text-[11px] font-semibold text-nim-muted uppercase tracking-wider">
        Trackers
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Filter chips (multi-select) */}
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
              onClick={() => activeFilters.forEach(f => onToggleFilter(f))}
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Saved Views Section (NIM-788) */}
        <div className="px-2 pt-2 pb-1 border-t border-nim mt-1" data-testid="tracker-saved-views">
          <div className="flex items-center justify-between px-1 mb-1.5">
            <span className="text-[10px] font-semibold text-nim-faint uppercase tracking-wider">
              Saved Views
            </span>
            <button
              className="flex items-center gap-0.5 text-[10px] text-nim-faint hover:text-nim transition-colors"
              onClick={() => setSavingView((v) => !v)}
              title="Save current view"
              data-testid="tracker-saved-view-add"
            >
              <MaterialSymbol icon="add" size={13} />
            </button>
          </div>

          {savingView && (
            <div className="flex items-center gap-1 mb-1.5 px-1">
              <input
                autoFocus
                type="text"
                value={newViewName}
                onChange={(e) => setNewViewName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitSaveView();
                  if (e.key === 'Escape') { setSavingView(false); setNewViewName(''); }
                }}
                placeholder="View name..."
                className="flex-1 min-w-0 px-2 py-1 text-[11px] bg-nim border border-nim rounded text-nim placeholder:text-nim-faint focus:outline-none focus:border-[var(--nim-primary)]"
                data-testid="tracker-saved-view-name-input"
              />
              <button
                className="px-1.5 py-1 text-[11px] text-white bg-[var(--nim-primary)] rounded hover:opacity-90 disabled:opacity-40"
                onClick={commitSaveView}
                disabled={!newViewName.trim()}
                data-testid="tracker-saved-view-save"
              >
                Save
              </button>
            </div>
          )}

          {savedViews.length === 0 ? (
            !savingView && (
              <div className="px-1 text-[10px] text-nim-faint italic">
                Save the current filters and layout as a reusable view.
              </div>
            )
          ) : (
            <div className="flex flex-col gap-0.5">
              {savedViews.map((view) => (
                <div
                  key={view.id}
                  className="group flex items-center gap-1 rounded-md hover:bg-nim-tertiary"
                  data-testid="tracker-saved-view-item"
                >
                  <button
                    className="flex-1 flex items-center gap-2 px-2 py-1.5 text-left text-[12px] text-nim-muted hover:text-nim min-w-0"
                    onClick={() => onApplyView(view)}
                    title={`Apply view: ${view.name}`}
                  >
                    <MaterialSymbol icon="bookmark" size={13} className="shrink-0" />
                    <span className="flex-1 truncate">{view.name}</span>
                  </button>
                  <button
                    className="opacity-0 group-hover:opacity-100 px-1.5 text-nim-faint hover:text-[#ef4444] transition-opacity"
                    onClick={() => onDeleteView(view.id)}
                    title="Delete view"
                    data-testid="tracker-saved-view-delete"
                  >
                    <MaterialSymbol icon="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
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

          {/* Individual types */}
          {trackerTypes.map((tracker) => (
            <button
              key={tracker.type}
              data-testid="tracker-type-button"
              data-tracker-type={tracker.type}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
                selectedType === tracker.type
                  ? 'bg-nim-active text-nim'
                  : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
              }`}
              onClick={() => onSelectType(tracker.type)}
            >
              <span style={{ color: tracker.color }}>
                <MaterialSymbol icon={tracker.icon} size={16} />
              </span>
              <span className="flex-1 text-left truncate">{tracker.displayNamePlural}</span>
              <span className="text-[10px] font-semibold text-nim-faint min-w-[20px] text-right">
                <SidebarTypeCount type={tracker.type as TrackerItemType} />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
