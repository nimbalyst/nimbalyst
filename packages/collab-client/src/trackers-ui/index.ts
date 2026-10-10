/**
 * Presentational tracker surfaces shared by the desktop renderer and the browser
 * console: list, grid, board, item detail, and the navigation that reaches them.
 *
 * Explicit export lists, not `export *` chains -- a re-export shim that silently
 * loses a symbol fails at the far end of the graph, in a host that never
 * changed.
 *
 * The entry, not a component, carries the surfaces' element reset: it is the
 * one module every host loads, and the rule has to be present before any
 * portalled markup mounts. See `primitives/trackerSurfaceReset.css`.
 */

import './primitives/trackerSurfaceReset.css';

export {
  TrackersUIProvider,
  useTrackersUI,
  useTrackerUICapabilities,
  useTrackerDataSourceOrThrow,
  useTrackerDataStoreOrThrow,
  BROWSER_TRACKER_UI_CAPABILITIES,
  DESKTOP_TRACKER_UI_CAPABILITIES,
} from './TrackersUIProvider';
export type {
  TrackersUIProviderProps,
  TrackersUIContextValue,
  TrackerUICapabilities,
} from './TrackersUIProvider';

export {
  useTrackerCommand,
  useTrackerData,
  useTrackerDataSelector,
} from './useTrackerData';
export type { TrackerDataState } from './useTrackerData';

export { useTrackerViewRows } from './useTrackerViewRows';
export type {
  TrackerViewRows,
  TrackerViewRowsOptions,
} from './useTrackerViewRows';

export { resolveViewMode, VIEW_MODE_FALLBACK } from './resolveViewMode';
export type { ResolvedViewMode, ViewModeCapabilities } from './resolveViewMode';

export { PersonalClauseNotice } from './PersonalClauseNotice';
export type { PersonalClauseNoticeProps } from './PersonalClauseNotice';
export {
  formatTrackerMutationRejection,
  TrackerMutationRejectionNotice,
} from './TrackerMutationRejectionNotice';
export type { TrackerMutationRejectionNoticeProps } from './TrackerMutationRejectionNotice';

export type {
  TrackerFilterField,
  TrackerFilterFieldOption,
} from './trackerFilterFields';
export { buildHeaderFilterFields } from './trackerHeaderFilterFields';
export {
  createTrackerFilterFields,
  getTrackerHeaderFilterValue,
} from './createTrackerFilterFields';

export {
  dispatchTrackerFocusSearch,
  TRACKER_FOCUS_SEARCH_EVENT,
  TrackerFilterOmnibox,
} from './TrackerFilterOmnibox';
export type { TrackerFilterOmniboxProps } from './TrackerFilterOmnibox';
export {
  LazyTrackerAdvancedFilterBuilder as TrackerAdvancedFilterBuilder,
  preloadTrackerAdvancedFilterBuilder,
} from './LazyTrackerAdvancedFilterBuilder';
export type { TrackerAdvancedFilterBuilderProps } from './TrackerAdvancedFilterBuilder';
export {
  LazyTrackerFilterValueMenu as TrackerFilterValueMenu,
  preloadTrackerFilterValueMenu,
} from './LazyTrackerFilterValueMenu';
export type { TrackerFilterValueMenuProps } from './TrackerFilterValueMenu';
export {
  LazyDisplayOptionsPanel as DisplayOptionsPanel,
  preloadDisplayOptionsPanel,
} from './LazyDisplayOptionsPanel';
export type { LazyDisplayOptionsPanelProps as DisplayOptionsPanelProps } from './LazyDisplayOptionsPanel';
export { TrackerViewHeaderControls } from './TrackerViewHeaderControls';
export type {
  TrackerViewHeaderControlsProps,
  TrackerViewLayoutUpdate,
} from './TrackerViewHeaderControls';
export {
  LazyTrackerTimelineView as TrackerTimelineView,
  preloadTrackerTimelineView,
} from './LazyTrackerTimelineView';
export type { TrackerTimelineViewProps } from './TrackerTimelineView';
export { TrackerRadarView } from './TrackerRadarView';
export type { TrackerRadarViewProps } from './TrackerRadarView';
export { LazyTagBoard as TagBoard, preloadTagBoard } from './LazyTagBoard';
export type { TagBoardProps } from './TagBoard';

export { TrackerActiveFilterPills } from './TrackerActiveFilterPills';
export { TrackerRecentActivityChip } from './TrackerRecentActivityChip';
export type { TrackerRecentActivityChipProps } from './TrackerRecentActivityChip';
export { TrackerViewTitle } from './TrackerViewTitle';
export { TrackerSavedViewsSection } from './TrackerSavedViewsSection';
export { TrackerDependencyCycleBanner } from './TrackerDependencyCycleBanner';
export { TrackerCommentsSection } from './TrackerCommentsSection';
export type {
  TrackerCommentMutation,
  TrackerCommentsSectionProps,
} from './TrackerCommentsSection';

export { TrackerListView } from './TrackerListView';
export type { TrackerListViewProps } from './TrackerListView';

export { TrackerSurfaceMessage } from './primitives/TrackerSurfaceMessage';
export type { TrackerSurfaceMessageProps } from './primitives/TrackerSurfaceMessage';
export { TrackerSwatchBadge } from './primitives/TrackerSwatchBadge';
export type { TrackerSwatchBadgeProps } from './primitives/TrackerSwatchBadge';

export { TrackerNavigation } from './navigation/TrackerNavigation';
export type { TrackerNavigationProps } from './navigation/TrackerNavigation';

export {
  ALL_TRACKERS_NAV_MODEL,
  TrackerNavTypeRow,
} from './navigation/TrackerNavTypeRow';
export type {
  TrackerNavTypeModel,
  TrackerNavTypeRowProps,
} from './navigation/TrackerNavTypeRow';

export { TrackerBoardCard } from './board/TrackerBoardCard';
export type { TrackerBoardCardProps } from './board/TrackerBoardCard';
export { TrackerCardStalenessChip } from './board/TrackerCardStalenessChip';
export { TrackerBoardSurface } from './board/TrackerBoardSurface';
export type { TrackerBoardSurfaceProps } from './board/TrackerBoardSurface';
export {
  registerKanbanDragCallbacks,
  resolveDropIndex,
} from './board/kanbanDragListeners';
export type {
  KanbanCardHit,
  KanbanDragCallbacks,
  KanbanDragOverCallback,
  KanbanDropCallback,
} from './board/kanbanDragListeners';
export {
  NEUTRAL_SWATCH,
  PRIORITY_COLORS,
  STATUS_CATEGORY_COLORS,
  STATUS_COLORS,
  TYPE_COLORS,
} from './board/trackerBoardTokens';

export {
  buildGridActionsColumn,
  buildGridColumns,
  buildGridSource,
  ROW_ACTIONS,
  ROW_ITEM_ID,
  ROW_ITEM_TYPE,
} from './grid/trackerGridColumns';
export type {
  BuildGridColumnsOptions,
  FavoritesOptions,
  KeyLinkOptions,
} from './grid/trackerGridColumns';
export {
  commitOnNavigationKeys,
  createRowAwareTrackerCellEditor,
  createTrackerCellEditor,
} from './grid/trackerGridEditors';
export type {
  RelationshipCandidate,
  TrackerEditorContext,
} from './grid/trackerGridEditors';
export { keydownOriginatedInGrid, useGridKeyOriginGuard } from './grid/gridKeyOrigin';
export { LazyTrackerColumnFilterPopover as TrackerColumnFilterPopover } from './grid/LazyTrackerColumnFilterPopover';
export type { TrackerColumnFilterPopoverProps } from './grid/TrackerColumnFilterPopover';
export { TrackerGridSurface } from './grid/TrackerGridSurface';
export type {
  TrackerGridSurfaceProps,
  TrackerGridUpdateEntry,
} from './grid/TrackerGridSurface';

export { TrackerItemDetailPanel } from './detail/TrackerItemDetailPanel';
export type { TrackerItemDetailPanelProps } from './detail/TrackerItemDetailPanel';
export { CopyLinkButton } from './detail/CopyLinkButton';
export type { CopyLinkButtonProps } from './detail/CopyLinkButton';
export { copyTextToClipboard } from './detail/copyTextToClipboard';
export { TrackerItemActionsMenu } from './detail/TrackerItemActionsMenu';
export type { TrackerItemActionsMenuProps } from './detail/TrackerItemActionsMenu';
export { TrackerActionList } from './detail/TrackerActionList';
export type {
  TrackerItemAction,
  TrackerActionListProps,
} from './detail/TrackerActionList';
export { TrackerContextMenu } from './detail/TrackerContextMenu';
export type {
  TrackerContextMenuPoint,
  TrackerContextMenuProps,
} from './detail/TrackerContextMenu';

export { getSupportedTrackerOrderingColumns } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerOrdering';
export { getTrackerTypeLabel, TRACKER_GROUPING_OPTIONS } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerGrouping';

// Resolver and context only. The view components are exported from the collab
// bundle's `./editor` entry, which already carries them for the node renderer;
// re-exporting them here would put them in the tracker surfaces' eager graph too.
export {
  createTrackerReferenceResolver,
  TrackerReferenceResolverContext,
  TrackerReferenceResolverProvider,
  useTrackerBacklinks,
  useTrackerReference,
  useTrackerReferenceResolver,
  useTrackerStatements,
  // The state word and its menu, for a host's own state line on the page item.
  TrackerStateMenu,
  stateTone,
} from './references';
export type {
  CreateTrackerReferenceResolverOptions,
  StateTone,
  TrackerBacklink,
  TrackerReferenceActor,
  TrackerReferenceStatusOption,
  TrackerStateChange,
  TrackerStateMenuProps,
  TrackerReferenceResolution,
  TrackerReferenceResolver,
  TrackerReferenceSchema,
  TrackerReferenceStatusInfo,
  TrackerReferenceTypeInfo,
  TrackerStatement,
  TrackerStatementGroup,
} from './references';

// The document-header field bar, for hosts that show a tracker item's fields
// above its body. Exported from here so a browser host shares this build's
// `globalRegistry` instead of compiling a second copy from runtime source.
export { StatusBar } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/StatusBar';
export type { StatusBarProps } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/StatusBar';

// Ontology inspector types, and the label reading shared by the web console
// Tracker setup screen, the wiki and its Types pages.
export type { OntologyViewModel, OntologyInput, TypeSummary, RelationshipGraph as OntologyRelationshipGraph, RelationshipEdge as OntologyRelationshipEdge, PredicatesSummary, KnowledgeSection } from './ontology/ontologyAnalysis';
export type { HealthItem, FactValue } from './ontology/ontologyKnowledge';
// Content health loads on demand with the Types pages: `loadOntologyTypesApi().computeContentHealth`.
export type { ContentHealthOptions } from './ontology/ontologyContentHealth';
export type { OntologyRecordLike } from './ontology/ontologyRecords';
export { OntologyInspector } from './ontology/LazyOntologyInspector';
export type { OntologyInspectorProps, OntologyInspectorWriter, OntologyInspectorView } from './ontology/OntologyInspector';
export type { DomainModel, DomainCategory, DomainGap, DomainLine } from './ontology/ontologyDomain';
// Labels: the wiki's Types section, fact boxes and roles read the registry
// through these, with the kind stand-in while a room has no `labels.yaml`.
export {
  buildLabelIndex,
  effectiveLabelRegistry,
  hasRole,
  isFallbackRegistry,
  isHomePage,
  labelById,
  labelName,
  LABELED_TYPE,
  narrowerLabels,
  propertyRange,
  recordEffectiveLabels,
  recordOwnLabels,
  recordRole,
} from './ontology/ontologyLabels';
export type { KindOption, LabelIndex } from './ontology/ontologyLabels';
export type { RelationshipStatus, TypeMapExpectation, TypeMapModel, TypeMapOptions, TypeMapProperty, TypeMapRelationship, TypeMapStatement, TypeMapType, TypeMapZone } from './ontology/ontologyLabelMap';
export type { TypeCell, TypePageModel, TypePageOptions, TypeProperty, TypeRelationship, TypeRow } from './ontology/ontologyTypePage';
// The type map, type pages and label health load on demand (see `ontologyTypesApi.ts`).
export type OntologyTypesApi = typeof import('./ontology/ontologyTypesApi');
export const loadOntologyTypesApi = (): Promise<OntologyTypesApi> => import('./ontology/ontologyTypesApi');
export { OntologyLabelReview, OntologyTypeMap } from './ontology/LazyOntologyTypes';
export type { OntologyLabelReviewProps } from './ontology/OntologyLabelReview';
export type { OntologyTypeMapProps } from './ontology/OntologyTypeMap';
export {
  CLAIM_FACT_STALE_DAYS,
  claimAsOf,
  claimAsOfPrecision,
  claimDisplayValue,
  compareClaimCurrency,
  effectiveProperties,
  isClaimAsserted,
  isClaimFactStale,
  isQualifiedFieldProperty,
  readClaimRecord,
} from '@nimbalyst/tracker-schema';
export type {
  AsOfPrecision,
  ClaimRecord,
  CurrentClaimValue,
  EffectiveProperty,
  FieldPropertyDefinition,
  LabelDefinition,
  LabelRegistry,
  LabelRole,
} from '@nimbalyst/tracker-schema';
