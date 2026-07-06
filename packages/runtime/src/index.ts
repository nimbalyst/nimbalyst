// Editor (Lexical-based rich text editor)
export * from './editor';
export * from './core/types';
export * from './core/DocumentService';
export * from './core/trackerOrigin';
export * from './auth/jwtScopes';
export * from './core/FileSystemService';
export * from './storage/repositories/DocumentsRepository';
// AI
export * from './ai/types';
export * from './ai/streaming';
export * from './ai/client';
export * from './ai/models';
export * from './ai/tools';
export * from './ai/modelConstants';
export * from './ai/adapters/sessionStore';
export { SessionManager } from './ai/server/SessionManager';
export { slimClaudeCodeChunkForStorage } from './ai/server/providers/claudeCode/toolChunkUtils';
export {
  DocumentContextService,
  type IDocumentContextService,
  type RawDocumentContext,
  type PreparedDocumentContext,
  type TextSelection,
  type UserMessageAdditions,
  type ContextPreparationResult,
  type ModeTransition,
} from './ai/services';
export * from './storage/repositories/AISessionsRepository';
export * from './storage/repositories/SessionFilesRepository';
export { AgentMessagesRepository } from './storage/repositories/AgentMessagesRepository';
export type { AgentMessagesStore } from './storage/repositories/AgentMessagesRepository';
export { TranscriptMigrationRepository } from './storage/repositories/TranscriptMigrationRepository';
// AI Chat Integration
export { AIChatIntegrationPlugin } from './ai/plugins/AIChatIntegrationPlugin';
export { editorRegistry } from './ai/EditorRegistry';
export type { EditorInstance } from './ai/EditorRegistry';
// Plugins
export { DocumentLinkPlugin } from './plugins/DocumentLinkPlugin';
export { DocumentReferenceNode, DocumentReferenceTransformer, LegacyDocumentReferenceTransformer, $createDocumentReferenceNode, $isDocumentReferenceNode } from './plugins/DocumentLinkPlugin/DocumentLinkNode';
export {
  TrackerReferenceNode,
  TrackerReferenceTransformer,
  TrackerReferenceChip,
  $createTrackerReferenceNode,
  $isTrackerReferenceNode,
  TRACKER_REFERENCE_URN_SCHEME,
  useResolvedTrackerReference,
  navigateToTrackerReference,
} from './plugins/TrackerLinkPlugin';
export type {
  ResolvedTrackerReference,
  SerializedTrackerReferenceNode,
} from './plugins/TrackerLinkPlugin';
// `DiffApprovalBarPlugin` / `DiffApprovalBar` were dropped -- the live diff approval UI is
// `UnifiedDiffHeader` in the electron renderer, fed by `useLexicalDiffState`.
export { useLexicalDiffState } from './plugins/DiffApprovalBar/useLexicalDiffState';
export type { LexicalDiffState } from './plugins/DiffApprovalBar/useLexicalDiffState';
export { SearchReplacePlugin, SearchReplaceBar, SearchReplaceStateManager } from './plugins/SearchReplace';
export type { SearchReplaceState } from './plugins/SearchReplace';
// Unified Tracker Plugin
export {
  TrackerPlugin,
  TrackerLexicalExtension,
  TRACKER_USER_COMMANDS,
  TRACKER_ITEM_TRANSFORMERS,
  TrackerItemNode,
  $createTrackerItemNode,
  $getTrackerItemNode,
  $isTrackerItemNode,
  loadBuiltinTrackers,
  DocumentHeaderRegistry,
  DocumentHeaderContainer,
  TrackerDocumentHeader,
  shouldRenderTrackerHeader,
  StatusBar,
  ModelLoader,
  globalRegistry,
  parseTrackerYAML,
  // Tracker data atoms (cross-platform reactive state)
  trackerItemsMapAtom,
  trackerDataLoadedAtom,
  trackerItemsArrayAtom,
  trackerItemsByTypeAtom,
  trackerItemByReferenceKeyAtom,
  trackerItemCountByTypeAtom,
  upsertTrackerItemAtom,
  removeTrackerItemAtom,
  replaceAllTrackerItemsAtom,
} from './plugins/TrackerPlugin';
export type {
  TrackerItemData,
  TrackerItemType,
  TrackerItemStatus,
  TrackerItemPriority,
  TrackerPluginProps,
  TrackerDataModel,
  TrackerSyncPolicy,
  TrackerSyncMode,
  TrackerSchemaRole,
  FieldDefinition,
  DocumentHeaderProvider,
  DocumentHeaderComponentProps,
} from './plugins/TrackerPlugin';
// Canonical TrackerRecord type
export type { TrackerRecord, TrackerRecordSystem, LinkedCommit } from './core/TrackerRecord';
export { trackerItemToRecord, trackerRecordToItem, dbRowToRecord, recordToDbParams } from './core/TrackerRecord';
// Generic Frontmatter Plugin
// Import triggers registration with DocumentHeaderRegistry (priority 50, below tracker's 100)
export {
  GenericFrontmatterHeader,
  shouldRenderGenericFrontmatter,
  extractFrontmatter,
  parseFields,
  inferFieldType,
  updateFieldInFrontmatter,
  hasGenericFrontmatter,
} from './plugins/FrontmatterPlugin';
export type {
  InferredField,
  InferredFieldType,
} from './plugins/FrontmatterPlugin';
// Virtual Documents
export * from './constants/virtualDocs';
export * from './documents/virtualDocTypes';
export { virtualDocHandler } from './documents/VirtualDocumentHandler';
// Components
export { VirtualDocumentBanner } from './components/VirtualDocumentBanner';
// UI Components
export * from './ui/AgentTranscript';
export * from './ui/icons/ProviderIcons';
export * from './ui/icons/MaterialSymbol';
export * from './ui/icons/fileIcons';
// Utils
export * from './utils/clipboard';
export * from './utils/dateUtils';
export * from './utils/fuzzyMatch';
export * from './utils/documentDiff';
export * from './utils/localAssetUrl';
// Mockup types - shared across packages
export type {
  DrawingPath,
  MockupSelection,
  MockupAnnotationData,
} from './mockup/types';
// Import for side effects - registers globals on Window
import './mockup/types';
// Mockup Plugin - Node exported separately to avoid circular dependency
export {
  MockupNode,
  $createMockupNode,
  $isMockupNode,
} from './plugins/MockupPlugin/MockupNode';
export type {
  MockupPayload,
  SerializedMockupNode,
} from './plugins/MockupPlugin/MockupNode';
export { MOCKUP_TRANSFORMER } from './plugins/MockupPlugin/MockupTransformer';
export {
  INSERT_MOCKUP_COMMAND,
  MockupLexicalExtension,
  generateMockupScreenshot,
} from './plugins/MockupPlugin';
export type {
  MockupPlatformService,
  MockupFileInfo,
  MockupPickerResult,
} from './plugins/MockupPlugin/MockupPlatformService';
export {
  setMockupPlatformService,
  getMockupPlatformService,
  hasMockupPlatformService,
} from './plugins/MockupPlugin/MockupPlatformService';
// Config
export { STYTCH_CONFIG, getStytchConfig } from './config/stytch';
// Extensions
export * from './extensions';
// Services
export { screenshotService } from './services/ScreenshotService';
export type { ScreenshotCapability } from './services/ScreenshotService';
// Editor context
export { DocumentPathProvider, useDocumentPath } from './DocumentPathContext';
// Workspace file link routing (NIM-1487)
export {
  isWorkspaceFileHref,
  openWorkspaceFileLink,
  setWorkspaceFileLinkOpener,
} from './editor/utils/workspaceLinkNavigation';
// Editor wrappers
export * from './editors';
// Sync types (for capacitor)
export type { SessionIndexEntry } from './sync/types';
// Themes
export * from './themes';
