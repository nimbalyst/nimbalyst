/**
 * Tracker surfaces for a browser host: list, grid, board, and item detail, plus
 * the headless selectors they read from.
 *
 * Deliberately its own entry rather than a line added to `./docs-ui`. That entry
 * has roughly four thousand gzip bytes of headroom left, and the grid alone --
 * RevoGrid's React wrapper, the column registry, the cell editors -- is many
 * times that. A host that only shows documents must not pay for a data grid.
 *
 * Item bodies are not here either. They mount through `./editor`, the same entry
 * the docs surface uses, so the Lexical graph stays in exactly one place and the
 * cold-paint contract has one owner (NIM-1764).
 */
export * from './internal/collab-client/src/trackers/index';
export * from './internal/collab-client/src/trackers-ui/index';
export { TagBoard, TrackerTimelineView, } from './internal/collab-client/src/trackers-ui/index';
export type { TagBoardProps, TrackerTimelineViewProps, } from './internal/collab-client/src/trackers-ui/index';
export { resolveViewMode, VIEW_MODE_FALLBACK, } from './internal/collab-client/src/trackers-ui/index';
export type { ResolvedViewMode, ViewModeCapabilities, } from './internal/collab-client/src/trackers-ui/index';
/**
 * Host-facing pieces a browser tracker surface needs that are not part of
 * either shared subpath.
 *
 * `parseBuiltinTrackers` is the builtin catalog this build ships; a browser
 * host feeds it to `BrowserTrackerSchemaStore` as the seed a synced schema
 * delta resolves against. It is re-exported here rather than imported from the
 * runtime source in the host, because the host aliasing runtime source would
 * compile a *second* copy of the model registry -- and the registry is a
 * module-level singleton the shared selectors read.
 */
export { parseBuiltinTrackers } from './internal/runtime/src/plugins/TrackerPlugin/models/ModelLoader';
export { computeReadiness } from './internal/runtime/src/plugins/TrackerPlugin/models/trackerReadiness';
export type { Readiness } from './internal/runtime/src/plugins/TrackerPlugin/models/trackerReadiness';
export { getRecordStatus, getRecordTitle, } from './internal/runtime/src/plugins/TrackerPlugin/trackerRecordAccessors';
export { getCellValue, getDefaultColumnConfig, getFieldForColumn, resolveColumnsForType, } from './internal/runtime/src/plugins/TrackerPlugin/components/trackerColumns';
export type { TrackerColumnDef, TypeColumnConfig, } from './internal/runtime/src/plugins/TrackerPlugin/components/trackerColumns';
export type { TrackerFieldFilter, TrackerFilterSet, } from './internal/runtime/src/plugins/TrackerPlugin/models/trackerFilters';
export type { TeamMemberOption } from './internal/runtime/src/plugins/TrackerPlugin/components/TrackerFieldEditor';
export type { TrackerNavigationEntry, TrackerNavigationFolder, TrackerTypePlacement, } from './internal/runtime/src/sync/trackerNavigation';
/**
 * Typed pages and type pages, loaded when a host opens one so the eager graph
 * above does not carry them: the typed page layout, its Links section and
 * crumb helpers, and the type page's table. Placed views are not here: they
 * render inside a page's editor (see `setBrowserPlacedViewRenderer` in
 * `./editor`), and their 2x2 chart is part of the editor graph.
 */
export declare const loadTrackerPage: () => Promise<typeof import("./internal/collab-client/src/trackers-ui/page/index")>;
