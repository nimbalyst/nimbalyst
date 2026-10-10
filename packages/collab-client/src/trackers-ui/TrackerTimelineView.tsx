/**
 * Timeline view: when the work is happening, laid out along a time axis.
 *
 * Rows are the saved view's grouping axis, so `Group by: Milestone` is a
 * milestone-per-row timeline and needs nothing of its own. Placement, bucketing,
 * and the undated split all come from `trackerTimelineLayout`; this file is the
 * presentation.
 *
 * Read-only by design for now. Dragging a bar to reschedule would have to write
 * a date field back, and no such gesture exists yet -- so the view shows dates
 * and never changes them.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { FloatingPortal, flip, offset, shift, useFloating, type VirtualElement } from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  MANUAL_TRACKER_ORDERING,
  type TrackerGroupBy,
  type TrackerOrdering,
  type TrackerRelationshipLabelResolver,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getRecordStatus, getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  buildTrackerTimeline,
  resolveTodayFraction,
  TIMELINE_CREATED_FIELD,
  type TrackerTimelineBar,
  type TrackerTimelineDates,
  type TrackerTimelineFields,
} from '@nimbalyst/collab-client/trackers';

export interface TrackerTimelineViewProps {
  items: TrackerRecord[];
  fields?: TrackerTimelineFields;
  /** Grouping axis from the saved view; one row per bucket. */
  groupBy?: TrackerGroupBy;
  /** Within-row order from the saved view, used as the chronological tiebreak. */
  ordering?: TrackerOrdering;
  onItemSelect?: (itemId: string) => void;
  onOpenDocument?: (itemId: string) => void;
  selectedItemId?: string | null;
  /** Resolve live titles for relationship-grouped rows from the host's visible corpus. */
  resolveRelationshipLabel?: TrackerRelationshipLabelResolver;
}

/** Left gutter holding the row's group label, sticky across horizontal scroll. */
const LABEL_WIDTH = 168;
/** The undated rail, present only when something in view is undated. */
const UNDATED_WIDTH = 208;
/** Enough width per bucket that its label is readable before scrolling starts. */
const MIN_BUCKET_WIDTH = 60;

const GRANULARITY_LABEL: Record<string, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
};

function humanizeFieldName(field: string): string {
  if (field === TIMELINE_CREATED_FIELD) return 'Created';
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function formatDay(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Bar fill by workflow status, so a row reads as progress and not just placement. */
function barToneClass(item: TrackerRecord, selected: boolean): string {
  if (selected) return 'bg-[var(--nim-primary)]';
  const status = (getRecordStatus(item) || '').toLowerCase();
  if (status === 'done' || status === 'completed') return 'bg-[var(--nim-success)]/60';
  if (status === 'blocked') return 'bg-[var(--nim-error)]/60';
  if (status === 'in-progress' || status === 'in-review') return 'bg-[var(--nim-primary)]/75';
  return 'bg-[var(--nim-text-faint)]/50';
}

interface HoveredBar {
  item: TrackerRecord;
  dates: TrackerTimelineDates;
  rect: DOMRect;
}

export const TrackerTimelineView: React.FC<TrackerTimelineViewProps> = ({
  items,
  fields,
  groupBy = 'none',
  ordering = MANUAL_TRACKER_ORDERING,
  onItemSelect,
  onOpenDocument,
  selectedItemId,
  resolveRelationshipLabel,
}) => {
  const timeline = useMemo(
    () => buildTrackerTimeline(items, groupBy, ordering, resolveRelationshipLabel, fields),
    [items, groupBy, ordering, resolveRelationshipLabel, fields],
  );

  const [hovered, setHovered] = useState<HoveredBar | null>(null);

  const { refs, floatingStyles } = useFloating({
    placement: 'top-start',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });

  // The anchor is the hovered bar's rect, handed over as a virtual element --
  // the documented escape hatch, so no coordinate is computed by hand.
  useEffect(() => {
    if (!hovered) {
      refs.setPositionReference(null);
      return;
    }
    const virtual: VirtualElement = {
      getBoundingClientRect: () => hovered.rect,
    };
    refs.setPositionReference(virtual);
  }, [hovered, refs]);

  const range = timeline.range;
  const hasUndated = timeline.undatedCount > 0;
  const contentMinWidth =
    LABEL_WIDTH + (hasUndated ? UNDATED_WIDTH : 0) + Math.max(timeline.buckets.length, 1) * MIN_BUCKET_WIDTH;

  // `new Date()` only ever reaches the marker, never placement -- so what the
  // timeline draws does not change under the reader's clock.
  const todayFraction = resolveTodayFraction(new Date(), timeline.range);

  if (items.length === 0) {
    return (
      <div
        className="tracker-timeline-view flex h-full items-center justify-center text-sm text-nim-muted"
        data-testid="tracker-timeline-empty"
      >
        No items to place on a timeline.
      </div>
    );
  }

  const handleSelect = (event: React.MouseEvent | React.KeyboardEvent, item: TrackerRecord): void => {
    event.stopPropagation();
    onItemSelect?.(item.id);
  };

  const renderUndatedChip = (item: TrackerRecord): React.ReactNode => (
    <button
      key={item.id}
      type="button"
      className={`tracker-timeline-undated-chip block w-full truncate rounded px-1.5 py-1 text-left text-[11px] transition-colors ${
        selectedItemId === item.id ? 'bg-[var(--nim-bg-selected)] text-nim' : 'text-nim-muted hover:bg-nim-hover'
      }`}
      onClick={(event) => handleSelect(event, item)}
      onDoubleClick={() => onOpenDocument?.(item.id)}
      title={getRecordTitle(item)}
    >
      {item.issueKey ? (
        <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.08em] text-nim-faint">{item.issueKey}</span>
      ) : null}
      {getRecordTitle(item)}
    </button>
  );

  const renderBar = (bar: TrackerTimelineBar): React.ReactNode => {
    const selected = selectedItemId === bar.item.id;
    // Past the three-quarter mark the label would run off the right edge, so it
    // is drawn back along the bar instead.
    const labelLeads = bar.endFraction > 0.75;
    return (
      <div key={bar.item.id} className="tracker-timeline-lane relative h-[24px]">
        <div
          className={`tracker-timeline-bar absolute inset-y-0 flex items-center gap-1.5 ${
            labelLeads ? 'flex-row-reverse' : ''
          }`}
          style={{
            left: `${bar.startFraction * 100}%`,
            width: `${Math.max(bar.endFraction - bar.startFraction, 0) * 100}%`,
            minWidth: '10px',
          }}
          role="button"
          tabIndex={0}
          onClick={(event) => handleSelect(event, bar.item)}
          onDoubleClick={() => onOpenDocument?.(bar.item.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleSelect(event, bar.item);
            }
          }}
          onMouseEnter={(event) =>
            setHovered({
              item: bar.item,
              dates: bar.dates,
              rect: event.currentTarget.getBoundingClientRect(),
            })
          }
          onMouseLeave={() => setHovered((current) => (current?.item.id === bar.item.id ? null : current))}
        >
          <span className={`h-[12px] w-full min-w-[10px] shrink-0 rounded-full ${barToneClass(bar.item, selected)}`} />
          <span className={`whitespace-nowrap text-[11px] leading-none ${selected ? 'text-nim' : 'text-nim-muted'}`}>
            {getRecordTitle(bar.item)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div
      className="tracker-timeline-view flex h-full flex-col bg-nim"
      data-component="TrackerTimelineView"
      data-testid="tracker-timeline"
    >
      <div className="tracker-timeline-legend flex shrink-0 items-center gap-3 border-b border-nim px-3 py-1.5 text-[11px] text-nim-muted">
        <span className="inline-flex items-center gap-1">
          <MaterialSymbol icon="align_horizontal_left" size={13} />
          {GRANULARITY_LABEL[timeline.granularity] ?? 'Timeline'}
        </span>
        <span>{timeline.datedCount} dated</span>
        {hasUndated ? (
          <span data-testid="tracker-timeline-undated-count">{timeline.undatedCount} with no date</span>
        ) : null}
        <span className="ml-auto">Read-only — dates are edited on the item</span>
      </div>

      <div className="tracker-timeline-scroll flex-1 overflow-auto">
        <div style={{ minWidth: `${contentMinWidth}px` }}>
          {/* Axis */}
          <div className="tracker-timeline-axis sticky top-0 z-20 flex border-b border-nim bg-nim-secondary">
            <div
              className="sticky left-0 z-10 shrink-0 bg-nim-secondary px-3 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-nim-faint"
              style={{ width: `${LABEL_WIDTH}px` }}
            >
              {groupBy === 'none' ? 'All items' : 'Group'}
            </div>
            {hasUndated ? (
              <div
                className="shrink-0 border-l border-nim px-2 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-nim-faint"
                style={{ width: `${UNDATED_WIDTH}px` }}
              >
                No dates
              </div>
            ) : null}
            <div className="relative min-w-0 flex-1 border-l border-nim">
              {range ? (
                timeline.buckets.map((bucket, index) => {
                  const left =
                    (bucket.start.getTime() - range.start.getTime()) / (range.end.getTime() - range.start.getTime());
                  return (
                    <div
                      key={bucket.key}
                      className={`absolute inset-y-0 px-1 py-1 text-[10px] text-nim-faint ${
                        index === 0 ? '' : 'border-l border-nim'
                      }`}
                      style={{ left: `${left * 100}%` }}
                    >
                      {bucket.label}
                    </div>
                  );
                })
              ) : (
                <div className="px-2 py-1 text-[10px] text-nim-faint">No dated items</div>
              )}
            </div>
          </div>

          {/* Rows */}
          {timeline.rows.map((row) => (
            <div key={row.key} className="tracker-timeline-row flex border-b border-nim">
              <div
                className="sticky left-0 z-10 shrink-0 bg-nim px-3 py-2 text-xs font-medium text-nim"
                style={{ width: `${LABEL_WIDTH}px` }}
              >
                <span className="block truncate" title={row.label}>
                  {row.label}
                </span>
                <span className="text-[10px] font-normal text-nim-faint">{row.bars.length + row.undated.length}</span>
              </div>

              {hasUndated ? (
                <div
                  className="tracker-timeline-undated shrink-0 space-y-0.5 border-l border-dashed border-nim px-1.5 py-1.5"
                  style={{ width: `${UNDATED_WIDTH}px` }}
                >
                  {row.undated.length > 0 ? (
                    row.undated.map(renderUndatedChip)
                  ) : (
                    <span className="px-1.5 text-[11px] text-nim-faint">—</span>
                  )}
                </div>
              ) : null}

              <div className="relative min-w-0 flex-1 space-y-0.5 border-l border-nim py-1.5">
                {todayFraction !== null ? (
                  <div
                    className="tracker-timeline-today pointer-events-none absolute inset-y-0 w-px bg-[var(--nim-primary)]/60"
                    style={{ left: `${todayFraction * 100}%` }}
                  />
                ) : null}
                {row.bars.length > 0 ? (
                  row.bars.map(renderBar)
                ) : (
                  <div className="px-2 text-[11px] text-nim-faint">No dated items</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {hovered ? (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="tracker-timeline-tooltip pointer-events-none z-50 max-w-[300px] rounded border border-nim bg-nim-secondary px-2 py-1.5 text-[11px] text-nim shadow-lg"
          >
            <div className="mb-0.5 font-medium">{getRecordTitle(hovered.item)}</div>
            <div className="text-nim-muted">
              {humanizeFieldName(hovered.dates.startField)}: {formatDay(hovered.dates.start)}
            </div>
            {hovered.dates.end && hovered.dates.endField ? (
              <div className="text-nim-muted">
                {humanizeFieldName(hovered.dates.endField)}: {formatDay(hovered.dates.end)}
              </div>
            ) : null}
          </div>
        </FloatingPortal>
      ) : null}
    </div>
  );
};
