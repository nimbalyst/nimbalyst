import React, { useMemo } from 'react';
import { MaterialSymbol, TrackerUnreadDot } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { TrackerFavoriteStar, type TrackerItemType } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { getRecordTitle, getRecordPriority, getFieldByRole } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { UserAvatar } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/UserAvatar';
import { groupTrackerItemsByTag } from './trackerTagFilterUtils';

interface TagBoardProps {
  filterType: TrackerItemType | 'all';
  searchQuery?: string;
  /** Items to display (already filtered upstream by TrackerMainView). */
  overrideItems?: TrackerRecord[];
  /** Callback when user clicks a card to open the detail panel. */
  onItemSelect?: (itemId: string) => void;
  /** Currently selected item ID for card highlighting. */
  selectedItemId?: string | null;
  favoriteItemIds?: ReadonlySet<string>;
  onToggleFavorite?: (itemId: string) => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#6b7280',
};

const TYPE_COLORS: Record<string, string> = {
  bug: '#dc2626',
  task: '#2563eb',
  plan: '#7c3aed',
  idea: '#ca8a04',
  decision: '#8b5cf6',
  feature: '#10b981',
};

/**
 * Tag board view (NIM-774). Columns are driven by the schema `tags` role —
 * one column per distinct tag plus a trailing "Untagged" bucket. An item with
 * multiple tags shows up in every matching column. Read + click-to-select; the
 * kanban board remains the place for drag-driven status changes.
 */
export const TagBoard: React.FC<TagBoardProps> = ({
  searchQuery,
  overrideItems,
  onItemSelect,
  selectedItemId,
  favoriteItemIds = new Set<string>(),
  onToggleFavorite,
}) => {
  const allItems = useMemo(() => {
    const source = overrideItems ?? [];
    if (!searchQuery) return source;
    const q = searchQuery.toLowerCase();
    return source.filter(
      (record) =>
        record.issueKey?.toLowerCase().includes(q) ||
        String(record.issueNumber ?? '').includes(q) ||
        getRecordTitle(record).toLowerCase().includes(q) ||
        record.system.documentPath?.toLowerCase().includes(q)
    );
  }, [searchQuery, overrideItems]);

  const columns = useMemo(() => groupTrackerItemsByTag(allItems), [allItems]);

  if (allItems.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-nim-muted">
        <div className="text-center">
          <MaterialSymbol icon="sell" size={48} className="opacity-30" />
          <p className="mt-2 text-sm">No items to display</p>
        </div>
      </div>
    );
  }

  if (columns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-nim-muted">
        <div className="text-center">
          <MaterialSymbol icon="sell" size={48} className="opacity-30" />
          <p className="mt-2 text-sm">No tags on these items yet</p>
          <p className="mt-1 text-xs text-nim-faint">Add tags to group them on the tag board.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tracker-tag-board h-full flex flex-col overflow-hidden relative" data-testid="tracker-tag-board">
      <div className="flex-1 flex gap-3 p-3 overflow-x-auto overflow-y-hidden min-h-0">
        {columns.map((col) => {
          const key = col.tag ?? '__untagged__';
          return (
            <div
              key={key}
              data-testid={`tracker-tag-board-column-${key}`}
              data-tag={col.tag ?? ''}
              className="tracker-tag-board-column flex flex-col min-w-[260px] max-w-[320px] flex-1 min-h-0 rounded-lg bg-nim-secondary"
            >
              {/* Column header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-nim">
                <MaterialSymbol
                  icon={col.tag === null ? 'label_off' : 'sell'}
                  size={13}
                  className="text-nim-faint shrink-0"
                />
                <span className="text-xs font-semibold text-nim truncate">
                  {col.tag === null ? 'Untagged' : `#${col.label}`}
                </span>
                <span className="text-[10px] font-semibold text-nim-faint ml-auto">
                  {col.items.length}
                </span>
              </div>

              {/* Column cards */}
              <div className="flex-1 overflow-y-auto p-1.5">
                {col.items.map((item) => (
                  <div
                    key={item.id}
                    data-testid="tracker-tag-board-card"
                    data-item-id={item.id}
                    role="button"
                    tabIndex={0}
                    className={`w-full text-left p-2.5 rounded-md bg-nim hover:bg-nim-tertiary border transition-colors cursor-pointer mb-1.5 ${
                      selectedItemId && item.id === selectedItemId
                        ? 'border-[var(--nim-primary)]'
                        : 'border-nim'
                    }`}
                    onClick={() => onItemSelect?.(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onItemSelect?.(item.id);
                      }
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                        style={{ backgroundColor: PRIORITY_COLORS[getRecordPriority(item) || 'medium'] || '#6b7280' }}
                      />
                      <TrackerUnreadDot itemId={item.id} className="mt-1" />
                      <TrackerFavoriteStar itemId={item.id} isFavorite={favoriteItemIds.has(item.id)} onToggle={onToggleFavorite} />
                      <div className="flex-1 min-w-0">
                        {item.issueKey && (
                          <div className="text-[10px] font-mono font-medium uppercase tracking-[0.08em] text-nim-faint mb-0.5">
                            {item.issueKey}
                          </div>
                        )}
                        <div className="text-sm text-nim leading-snug line-clamp-2">
                          {getRecordTitle(item)}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                            style={{
                              color: TYPE_COLORS[item.primaryType] || '#6b7280',
                              backgroundColor: `${TYPE_COLORS[item.primaryType] || '#6b7280'}20`,
                            }}
                          >
                            {item.primaryType}
                          </span>
                          {(() => {
                            const owner = getFieldByRole(item, 'assignee') as string | undefined;
                            return owner ? (
                              <span className="ml-auto">
                                <UserAvatar identity={owner} size={18} />
                              </span>
                            ) : null;
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                {/* Spacer */}
                <div className="min-h-[40px]" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
