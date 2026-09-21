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
  capClaudeCodeChunkForStorage,
  capToolResultContent,
  capToolResultText,
  STORAGE_TOOL_RESULT_BUDGET_BYTES,
} from './storage/toolOutputBudget';
export {
  isTombstoned,
  tombstoneMarker,
  tombstoneRawContent,
} from './storage/toolOutputRetention';
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
  TrackerReferencePicker,
  $createTrackerReferenceNode,
  $isTrackerReferenceNode,
  TRACKER_REFERENCE_URN_SCHEME,
  useResolvedTrackerReference,
  navigateToTrackerReference,
} from './plugins/TrackerLinkPlugin';
export type {
  ResolvedTrackerReference,
  SerializedTrackerReferenceNode,
  TrackerReferenceChipProps,
  TrackerReferencePickerProps,
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
  orgTrackerItemsAtom,
  replaceOrgTrackerItemsAtom,
} from './plugins/TrackerPlugin';
export type {
  TrackerItemData,
  TrackerItemType,
  TrackerItemStatus,
  TrackerItemPriority,
  TrackerPluginProps,
  TrackerDataModel,
  TrackerSharing,
  TrackerSharingPolicy,
  TrackerSchemaRole,
  FieldDefinition,
  DocumentHeaderProvider,
  DocumentHeaderComponentProps,
} from './plugins/TrackerPlugin';
// Canonical TrackerRecord type
export type { TrackerRecord, TrackerRecordSystem, LinkedCommit, TrackerDerivedSignal } from './core/TrackerRecord';
export { trackerItemToRecord, trackerRecordToItem, dbRowToRecord, recordToDbParams } from './core/TrackerRecord';
export {
  PLAN_INVALID_STATUS_SIGNAL_KIND,
  PLAN_STATUS_DRIFT_SIGNAL_KIND,
  derivePlanStatusSignals,
  normalizePlanStatusForProjection,
} from './plugins/TrackerPlugin/models/planStatusIntegrity';
export type {
  InvalidPlanStatusSignal,
  PlanStatusDriftSignal,
  StalePlanStatus,
} from './plugins/TrackerPlugin/models/planStatusIntegrity';
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
export * from './utils/markdownLink';
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
// Config
export { STYTCH_CONFIG, getStytchConfig } from './config/stytch';
// Extensions
export * from './extensions';
// Services
export { screenshotService } from './services/ScreenshotService';
export type { ScreenshotCapability, ScreenshotCaptureProvider } from './services/ScreenshotService';
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
export * from './sync/ConversationSync';
export * from './sync/FeedbackRequestSync';
// Read receipts (unread indicators for trackers/docs)
export {
  isEntityUnread,
  mergeReceipt,
  receiptAdvances,
} from './readReceipts/readReceipts';
export type {
  ReadReceipt,
  ReadReceiptEntityKind,
  SyncedReadReceipt,
  UnreadEntitySnapshot,
} from './readReceipts/readReceipts';
export {
  trackerUnreadAtom,
  trackerUnreadByWorkspaceAtom,
  trackerReceiptsAtom,
  setTrackerUnreadAtom,
  recomputeTrackerUnreadAtom,
  applyTrackerReceiptAtom,
  trackerSnapshot,
} from './readReceipts/trackerUnreadAtoms';
export { TrackerUnreadDot } from './readReceipts/TrackerUnreadDot';
// Themes
export * from './themes';
