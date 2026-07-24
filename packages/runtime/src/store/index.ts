/**
 * Jotai Store Exports
 *
 * Central export point for all Jotai atoms and utilities.
 * These atoms are shared across platforms (Electron, Capacitor).
 *
 * @example
 * import { store, themeAtom, makeEditorKey } from '@nimbalyst/runtime/store';
 */

// Store instance
export { store, getStore } from './store';

// EditorKey utilities
export {
  type EditorKey,
  type EditorContext,
  makeEditorKey,
  makeEditorContext,
  parseEditorKey,
  getFilePathFromKey,
  isWorktreeKey,
  isMainKey,
  getKeysForFilePath,
} from './utils/editorKey';

// Theme atoms
export {
  themeIdAtom,
  themeAtom,
  isDarkThemeAtom,
  themeColorsAtom,
  setThemeAtom,
  getThemeById,
  registerCustomTheme,
  type ThemeId,
  type Theme,
  type ThemeColors,
} from './atoms/theme';

// Editor atoms
export {
  editorDirtyAtom,
  editorProcessingAtom,
  editorHasUnacceptedChangesAtom,
  tabIdsAtom,
  activeTabIdAtom,
  tabMetadataAtom,
  dirtyEditorCountAtom,
  hasAnyPendingReviewAtom,
  addTabAtom,
  closeTabAtom,
  reorderTabsAtom,
  type TabMetadata,
} from './atoms/editors';

// Document model atoms (per-file, shared across editor instances)
export {
  documentDirtyAtom,
  documentDiffStateAtom,
  documentAttachCountAtom,
  registeredDocumentPathsAtom,
  dirtyDocumentCountAtom,
  hasAnyPendingDiffAtom,
  type DocumentDiffState,
} from './atoms/documents';

// Git commit proposal types (widget uses tool call data directly, no atoms needed)
export { type GitCommitProposalData } from './atoms/gitCommitProposals';

// Interactive widget host atoms
export {
  interactiveWidgetHostAtom,
  setInteractiveWidgetHost,
  registerInteractiveWidgetHost,
  unregisterInteractiveWidgetHost,
  getInteractiveWidgetHost,
  cleanupInteractiveWidgetHost,
} from './atoms/interactiveWidgetHost';
