/**
 * Typed pages and type pages as document pages, shared by the desktop and the
 * web console: the typed page layout, the add-field menu, the Links section,
 * the crumb helpers and the type page's table. Its
 * own entry so the eager `trackers-ui` graph does not carry the field-pill
 * editors; a host loads it when it opens a typed page.
 */
export { TrackerPageView, type TrackerPageViewProps } from './TrackerPageView';
export { TrackerPageAddField, type TrackerPageAddFieldProps } from './TrackerPageAddField';
export { PageHistoryButton } from './PageHistoryButton';
export { PageHeaderBar, pageAncestorIcon, pageHeaderCrumbs, type PageHeaderBarProps, type PageHeaderMenuItem } from './PageHeaderBar';
export { PlainPageHeader, type PlainPageHeaderProps } from './PlainPageHeader';
export { PageFacts, pageTimeFacts, relativePageTime, type PageFact } from './PageFacts';
export type { PageTreeAncestor } from '../embed/pageTreeAncestors';
export { TypePageTable, typePageTypeIds, type TypePageTableProps } from './TypePageTable';
export { TrackerLinksSection, type TrackerLinksSectionProps } from './TrackerLinksSection';
export { fieldRelationLinks } from './fieldRelationLinks';
export { browserTypeResolver, useBrowserTypeResolver } from '../browserTypeResolver';
export { groupTrackerPageLinks, type LinkedPage, type PageLinksSource, type TrackerLinkGroup, type TrackerPageLink } from './pageLinks';
export { crumbItemLookup, legacyDescriptionToRecover, sameTrackerPageCrumb, trackerPageCrumb, trackerPageCrumbFolders, trackerPageCrumbFolderRefs, type CrumbDocument, type CrumbFolder, type CrumbItemLookup, type CrumbItemPlacement, type CrumbPlacement, type TrackerPageCrumb, } from './trackerPageCrumb';
export { PagesSearchView, type PagesOpenOptions, type PagesSearchViewProps, type PagesSearchLane } from './PagesSearchView';
export { PagesTypesView, type PagesTypesViewMode, type PagesTypesViewProps } from './PagesTypesView';
export { EMPTY_PAGES_SEARCH, pagesSearchQuery, parsePagesSearch, type PagesSearchPageInput, type PagesSearchState } from './pagesSearch';
export { TITLE_MAX_HEIGHT_PX, resizeTitleField, sanitizeTitleInput, useAutoSizedTitle } from './trackerTitleAutoSize';
export { parsePlacedViewHandoff, type PlacedViewHandoff } from './placedViewHandoff';
