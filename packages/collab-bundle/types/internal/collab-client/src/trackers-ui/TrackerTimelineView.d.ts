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
import React from 'react';
import type { TrackerRecord } from '../../../runtime/src/core/TrackerRecord';
import { type TrackerGroupBy, type TrackerOrdering, type TrackerRelationshipLabelResolver } from '../../../runtime/src/plugins/TrackerPlugin/models/index';
import { type TrackerTimelineFields } from '../trackers/index';
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
export declare const TrackerTimelineView: React.FC<TrackerTimelineViewProps>;
