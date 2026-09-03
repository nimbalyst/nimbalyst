/**
 * The view modes Display Settings offers, in the order the panel shows them.
 *
 * Every mode here is one TrackerMainView renders. A mode that is selectable but
 * silently draws a different view is worse than no control at all, so this file
 * deliberately has no mapping step.
 */
/** Every mode a saved view (or the persisted layout) may carry. */
export type TrackerViewMode = 'list' | 'table' | 'kanban' | 'timeline' | 'radar' | 'tag-board' | 'inbox';
export interface TrackerViewModeOption {
    value: TrackerViewMode;
    label: string;
    icon: string;
}
export declare const VIEW_MODE_PRESENTATION: Record<TrackerViewMode, Omit<TrackerViewModeOption, 'value'>>;
export declare const TRACKER_VIEW_MODE_OPTIONS: readonly TrackerViewModeOption[];
/** Narrow an arbitrary string (a panel choice, persisted state) to a mode. */
export declare function normalizeTrackerViewMode(value: unknown, fallback?: TrackerViewMode): TrackerViewMode;
