/**
 * Narrow runtime entry used by the Electron main-process bundle.
 *
 * The public runtime barrel also exports the renderer, editor, and extension
 * loader. Pointing Electron main at that barrel makes Rollup watch those
 * renderer-only modules, so editing one restarts Electron and reloads every
 * open workspace window even when the main-process bundle cannot change.
 * Keep this entry limited to values that main-process code imports from the
 * package root; explicit runtime subpath imports continue to resolve normally.
 */

export { STYTCH_CONFIG } from './config/stytch';
export {
  asPersonalJwt,
  asPersonalMemberId,
  asTeamJwt,
  asTeamMemberId,
} from './auth/jwtScopes';
export type {
  PersonalJwt,
  PersonalMemberId,
  TeamJwt,
  TeamMemberId,
} from './auth/jwtScopes';
export {
  ConversationSync,
  ConversationSyncError,
} from './sync/ConversationSync';
export type {
  ConversationAppendInput,
  ConversationHistoryPage,
  ConversationSyncConfig,
  ConversationSyncEvent,
  ConversationTarget,
} from './sync/ConversationSync';
export type {
  AgentMessage,
  ChatAttachment,
  CreateAgentMessageInput,
  FileLink,
  FileLinkType,
} from './ai/server/types';
export type {
  ChatSession,
  CreateSessionPayload,
  SessionListOptions,
  SessionMeta,
  SessionSearchOptions,
  SessionStore,
  UpdateSessionMetadataPayload,
} from './ai/adapters/sessionStore';
export type {
  Document,
  DocumentMetadataEntry,
  DocumentOpenOptions,
  DocumentService,
  ExternalSourceRef,
  MetadataChangeEvent,
  TrackerIdentity,
  TrackerItem,
  TrackerItemChangeEvent,
  TrackerItemType,
  TrackerOrigin,
} from './core/DocumentService';
export type { DocumentRecord } from './core/types';
export type { DocumentsRepository } from './storage/repositories/DocumentsRepository';
export { trackerItemToRecord } from './core/TrackerRecord';
export type { LinkedCommit } from './core/TrackerRecord';
export type {
  FileInfo,
  FileListOptions,
  FileReadOptions,
  FileSearchOptions,
  FileSearchResult,
  FileSystemService,
} from './core/FileSystemService';
export type {
  PreparedDocumentContext,
  RawDocumentContext,
} from './ai/services/types';
export type { SessionFileStore } from './storage/repositories/SessionFilesRepository';
export type {
  ProjectFileEdit,
  ProjectFileSnapshot,
  ProjectFileWriteReceipt,
} from '@nimbalyst/extension-sdk';
export type {
  PermissionScope,
} from './ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
export {
  clearFileSystemService,
  clearFileSystemServiceFor,
  setFileSystemService,
  setFileSystemServiceFor,
} from './core/FileSystemService';
export { VIRTUAL_DOCS, isVirtualPath } from './constants/virtualDocs';
export { fuzzyMatchPath } from './utils/fuzzyMatch';
export { DocumentContextService } from './ai/services/DocumentContextService';
export {
  CLAUDE_CODE_NATIVE_1M_VARIANTS,
  claudeCodeFamilyKeyword,
  normalizeClaudeCodeVariant,
  resolveClaudeCodeParentContextWindow,
} from './ai/modelConstants';
export { slimClaudeCodeChunkForStorage } from './ai/server/providers/claudeCode/toolChunkUtils';
export { AISessionsRepository } from './storage/repositories/AISessionsRepository';
export { AgentMessagesRepository } from './storage/repositories/AgentMessagesRepository';
export { SessionFilesRepository } from './storage/repositories/SessionFilesRepository';
export { TranscriptMigrationRepository } from './storage/repositories/TranscriptMigrationRepository';
export { reconstructCollabContentAdapterFromDescriptor } from '@nimbalyst/extension-sdk';
