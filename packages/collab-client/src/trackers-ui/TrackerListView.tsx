/**
 * The compact list: one row per item, grouped by the view's `groupBy`.
 *
 * The default landing view for a tracker, and the one surface that has to work
 * before any of the others matter. Grouping and ordering come from the shared
 * selectors so a list and a board built from the same saved view show the same
 * items in the same order.
 */

import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerGroupBy } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getTrackerTypeLabel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerGrouping';
import { getStatusColor, getTypeColor } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import {
  getFieldByRole,
  getRecordPriority,
  getRecordStatus,
  getRecordTitle,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { UserAvatar } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/UserAvatar';
import { groupTrackerItems } from '@nimbalyst/collab-client/trackers';
import { collabOpenOptions, type CollabOpenOptions } from '@nimbalyst/collab-client/core';
import { TrackerSurfaceMessage } from './primitives/TrackerSurfaceMessage';
import { TrackerSwatchBadge } from './primitives/TrackerSwatchBadge';
import { NEUTRAL_SWATCH, PRIORITY_COLORS } from './board/trackerBoardTokens';
import './trackerList.css';
import { TrackerStackedRow } from './TrackerStackedRow';

const subscribeSchema = (listener: () => void) => globalRegistry.onChange(listener);

export interface TrackerListViewProps {
  rows: TrackerRecord[];
  groupBy: TrackerGroupBy;
  selectedItemId?: string | null;
  /** `options` carries Cmd/Ctrl from the click, so a host can open a new tab. */
  onOpenItem: (itemId: string, options?: CollabOpenOptions) => void;
  loaded: boolean;
  /** Host opts into a touch-first row without changing desktop consumers. */
  stacked?: boolean;
  showType?: boolean;
  /**
   * Per-row unread dot. Personal lane, so a host with team auth only omits it
   * and the dot's module never enters that host's bundle graph.
   */
  renderUnreadSlot?: (itemId: string) => React.ReactNode;
  /**
   * Right-click on a row. Omit and the browser's own menu is left alone, which
   * is what the desktop does -- it catches the gesture on its grid instead.
   */
  onRowContextMenu?: (itemId: string, event: React.MouseEvent) => void;
}

function TrackerListRow({
  item,
  selected,
  unreadSlot,
  onOpen,
  onContextMenu,
}: {
  item: TrackerRecord;
  selected: boolean;
  unreadSlot: React.ReactNode;
  onOpen: (event: React.MouseEvent) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const status = getRecordStatus(item);
  const priority = getRecordPriority(item);
  const owner = getFieldByRole(item, 'assignee') as string | undefined;
  return (
    <button
      type="button"
      data-testid="tracker-list-row"
      data-item-id={item.id}
      className={`tracker-list-row w-full flex items-center gap-2 px-3 py-1.5 text-left border-b border-nim transition-colors ${
        selected ? 'bg-nim-active' : 'hover:bg-nim-tertiary'
      }`}
      onClick={onOpen}
      onContextMenu={onContextMenu}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: PRIORITY_COLORS[priority || 'medium'] || NEUTRAL_SWATCH }}
      />
      {unreadSlot}
      {item.issueKey ? (
        // `text-nim-muted`, not `text-nim-faint`: the key is the item's
        // citable identifier, so it is content. Faint is the decorative tier
        // and measures 3.49:1 on the dark row background, under AA at any size.
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.06em] text-nim-muted">
          {item.issueKey}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-sm text-nim">{getRecordTitle(item)}</span>
      <TrackerSwatchBadge
        label={getTrackerTypeLabel(item.primaryType)}
        color={getTypeColor(item.primaryType)}
        className="tracker-swatch-badge-column"
      />
      {status ? (
        <TrackerSwatchBadge
          label={status}
          color={getStatusColor(status, item.primaryType)}
          className="tracker-swatch-badge-column"
        />
      ) : null}
      <span className="tracker-list-row-owner">
        {owner ? <UserAvatar identity={owner} size={18} /> : null}
      </span>
    </button>
  );
}

export function TrackerListView({
  rows,
  groupBy,
  selectedItemId = null,
  onOpenItem,
  loaded,
  renderUnreadSlot,
  onRowContextMenu,
  stacked = false,
  showType = true,
}: TrackerListViewProps) {
  // Cached rows may arrive before their schema. Track the registry's existing
  // change signal without requiring a provider for this presentational leaf.
  const getSchemaNames = useCallback(() => JSON.stringify(
    [...new Set(rows.map(row => row.primaryType))].map(type => {
      const model = globalRegistry.get(type);
      return [type, model?.displayName, model?.displayNamePlural];
    }),
  ), [rows]);
  const schemaNames = useSyncExternalStore(subscribeSchema, getSchemaNames, getSchemaNames);
  const groups = useMemo(() => groupTrackerItems(rows, groupBy), [rows, groupBy, schemaNames]);

  if (!loaded) {
    return (
      <TrackerSurfaceMessage
        icon="checklist"
        message="Loading tracker items..."
        testId="tracker-list-loading"
      />
    );
  }

  if (rows.length === 0) {
    return (
      <TrackerSurfaceMessage
        icon="checklist"
        message="No items to display"
        hint="Nothing in this tracker matches the current view."
        testId="tracker-list-empty"
      />
    );
  }

  return (
    <div className="tracker-list-view h-full overflow-y-auto" data-testid="tracker-list-view">
      {groups.map((group) => (
        <div key={group.key} data-testid="tracker-list-group" data-group-key={group.key}>
          {groupBy === 'none' ? null : (
            <div className="sticky top-0 z-[1] flex items-center gap-2 bg-nim-secondary px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-nim-muted">
              <MaterialSymbol icon="chevron_right" size={12} />
              <span className="flex-1 truncate">{group.label}</span>
              <span>{group.items.length}</span>
            </div>
          )}
          {group.items.map((item) => stacked ? (
            <TrackerStackedRow key={item.id} item={item} selected={selectedItemId === item.id} showType={showType} onOpen={(event) => onOpenItem(item.id, collabOpenOptions(event))} />
          ) : (
            <TrackerListRow
              key={item.id}
              item={item}
              selected={selectedItemId === item.id}
              unreadSlot={renderUnreadSlot?.(item.id)}
              onOpen={(event) => onOpenItem(item.id, collabOpenOptions(event))}
              onContextMenu={onRowContextMenu
                ? (event) => onRowContextMenu(item.id, event)
                : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
