/**
 * Jotai Store Exports
 *
 * Central export point for all Jotai atoms and utilities.
 * These atoms are shared across platforms (Electron, Capacitor).
 *
 * @example
 * import { store, themeAtom, makeEditorKey } from './index';
 */
export { store, getStore } from './store';
export { type EditorKey, type EditorContext, makeEditorKey, makeEditorContext, parseEditorKey, getFilePathFromKey, isWorktreeKey, isMainKey, getKeysForFilePath, } from './utils/editorKey';
export { themeIdAtom, themeAtom, isDarkThemeAtom, themeColorsAtom, setThemeAtom, getThemeById, registerCustomTheme, type ThemeId, type Theme, type ThemeColors, } from './atoms/theme';
export { editorDirtyAtom, editorProcessingAtom, editorHasUnacceptedChangesAtom, tabIdsAtom, activeTabIdAtom, tabMetadataAtom, dirtyEditorCountAtom, hasAnyPendingReviewAtom, addTabAtom, closeTabAtom, reorderTabsAtom, type TabMetadata, } from './atoms/editors';
export { documentDirtyAtom, documentDiffStateAtom, documentAttachCountAtom, registeredDocumentPathsAtom, dirtyDocumentCountAtom, hasAnyPendingDiffAtom, type DocumentDiffState, } from './atoms/documents';
export { type GitCommitProposalData } from './atoms/gitCommitProposals';
export { interactiveWidgetHostAtom, setInteractiveWidgetHost, registerInteractiveWidgetHost, unregisterInteractiveWidgetHost, getInteractiveWidgetHost, cleanupInteractiveWidgetHost, } from './atoms/interactiveWidgetHost';
