/**
 * DisplayOptionsPanel -- the whole control surface for a tracker view: which
 * view mode renders it, which axis its columns group by, how items are ordered
 * within a group, and which columns the table shows.
 *
 * Every knob here belongs to the saved view, so the caller's change handlers
 * write view state rather than a local presentation flag.
 */
import React from 'react';
import type { TrackerGroupBy } from '../models/trackerGrouping';
import type { TrackerOrdering } from '../models/trackerOrdering';
import { type DisplayOptionsViewMode } from './DisplayViewSettings';
import { type TrackerColumnDef, type TypeColumnConfig } from './trackerColumns';
export type { DisplayOptionsViewMode } from './DisplayViewSettings';
interface DisplayOptionsPanelProps {
    /** All available columns for this type */
    availableColumns: TrackerColumnDef[];
    /** Current column config */
    config: TypeColumnConfig;
    /** Called when config changes */
    onConfigChange: (config: TypeColumnConfig) => void;
    /** Close the panel */
    onClose: () => void;
    /**
     * The trigger the panel hangs off. Required, and never optional: a tracker
     * view lives inside scrolling and transformed containers, so an inline
     * `absolute` fallback clips against the wrong ancestor. `null` is only the
     * before-first-paint value of a trigger ref; the panel repositions the moment
     * the element exists.
     */
    anchorElement: HTMLElement | null;
    /** View modes to offer; omitted (or empty) drops the view-mode row. */
    viewModes?: readonly DisplayOptionsViewMode[];
    /** Currently rendered view mode. */
    viewMode?: string;
    onViewModeChange?: (viewMode: string) => void;
    /** Grouping axis for the board's columns and the list's groups. */
    groupBy?: TrackerGroupBy;
    onGroupByChange?: (groupBy: TrackerGroupBy) => void;
    /** Manual (dragged) order, or a sortable column to order by. */
    ordering?: TrackerOrdering;
    onOrderingChange?: (ordering: TrackerOrdering) => void;
    /**
     * Whether the view has table columns to configure. Board and inbox modes
     * still get the view settings above, just not the column properties.
     */
    showColumnProperties?: boolean;
}
/**
 * The panel and the selects it contains are separate floating layers, so they
 * share a tree: a press inside the grouping or ordering dropdown then counts as
 * a press inside the panel rather than a dismissal.
 */
export declare const DisplayOptionsPanel: React.FC<DisplayOptionsPanelProps>;
