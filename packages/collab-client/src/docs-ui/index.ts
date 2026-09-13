export * from './CollabCreateItemDialog';
export * from './CollabDocsUIProvider';
export * from './CollabNewDocumentMenu';
export * from './CollabSidebar';
export * from './DocUnreadDot';
export * from './documentDrag';
export * from './documentPresentation';
export * from './primitives/CollabSearchInput';
export * from './primitives/EditorHeaderBar';
export * from './primitives/ScopeSummaryHeader';
export * from './SharedDocsHome';
// `SharedDocsItemMenu` is deliberately not exported: the list lazy-loads it so
// the menu, its move dialog and the rename modal stay out of the docs-ui
// entry's eager graph, which has a gzip budget (see check-production-output).
export * from './SharedDocsListView';
