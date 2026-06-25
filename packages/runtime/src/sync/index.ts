/**
 * Session Sync Module
 *
 * Provides optional real-time sync of AI sessions across devices using CollabV3.
 *
 * Usage:
 *
 * ```typescript
 * import { createCollabV3Sync, createSyncedSessionStore } from '@nimbalyst/runtime/sync';
 *
 * // 1. Create sync provider with JWT auth
 * const syncProvider = createCollabV3Sync({
 *   serverUrl: 'wss://sync.nimbalyst.com',
 *   jwt: stytchSessionJwt, // User ID extracted from 'sub' claim
 *   encryptionKey: derivedKey, // Required for E2E encryption
 * });
 *
 * // 2. Wrap your existing session store
 * const baseStore = createPGLiteSessionStore(...);
 * const syncedStore = createSyncedSessionStore(baseStore, syncProvider);
 *
 * // 3. Use the synced store
 * AISessionsRepository.setStore(syncedStore);
 *
 * // 4. Optionally set up message sync
 * const messageSyncHandler = createMessageSyncHandler(syncProvider);
 * // Call messageSyncHandler.onMessageCreated() after each message
 * ```
 *
 * The sync layer is completely optional. If not configured, the app works
 * exactly as before with local-only storage.
 */

export type {
  SyncConfig,
  SyncStatus,
  SyncProvider,
  SessionChange,
  SyncedSessionMetadata,
  SyncedQueuedPrompt,
  SessionIndexEntry,
  ProjectIndexEntry,
  ProjectConfig,
  SyncedSlashCommand,
  EncryptedAttachment,
  DeviceInfo,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionControlMessage,
  SyncedSettings,
  SyncedAvailableModel,
  SyncedUsageSnapshot,
  SyncedUsageWindow,
} from './types';

export { createCollabV3Sync } from './CollabV3Sync';

export {
  setSyncClientInfo,
  getSyncClientInfo,
  appendSyncClientParams,
  type SyncClientInfo,
} from './syncClientInfo';

export {
  createSyncedSessionStore,
  createMessageSyncHandler,
  type SyncedSessionStoreOptions,
} from './SyncedSessionStore';

export {
  DocumentSyncProvider,
  createDocumentSyncProvider,
} from './DocumentSync';

export {
  CollabLexicalProvider,
} from './CollabLexicalProvider';

export {
  CollabHistoryClient,
  CollabHistoryError,
  decryptRevisionPayload,
} from './collabHistoryClient';

export type {
  CollabHistoryClientConfig,
  CreateRevisionInput,
  LoadedRevision,
} from './collabHistoryClient';

export type {
  DocumentSyncConfig,
  DocumentSyncStatus,
  AwarenessState,
  SerializedRelativePosition,
  ReviewGateState,
  DocClientMessage,
  DocServerMessage,
} from './documentSyncTypes';

export {
  ECDHKeyManager,
  createECDHKeyManager,
} from './ECDHKeyManager';

export type {
  ECDHKeyPair,
  SerializedECDHKeyPair,
  KeyEnvelope,
} from './ECDHKeyManager';

// ============================================================================
// Tracker sync (rewrite in progress)
// ============================================================================
//
// The TrackerSyncProvider / trackerSyncTypes module has been removed as part
// of the tracker sync rewrite (see design/Collaboration/tracker-sync-redesign.md
// and the phase-1 deletion described there).
//
// Phase 1 exports the metadata-layer wire protocol as type-only declarations
// from `./trackerProtocol`. The phase-3 client engine
// (`TrackerSyncEngine`, replaces `TrackerSyncProvider`) will be added when
// phase 3 lands.

export type {
  TeamProjectId,
  TrackerRoomId,
  SyncId,
  EncryptedTrackerItemEnvelope,
  TrackerItemPayload,
  TrackerCommentEntry,
  TrackerIdentity,
  TrackerPayloadSystem,
  LabelEntry,
  TrackerClientMessage,
  TrackerServerMessage,
  TrackerSyncRequestMessage,
  TrackerMutationRequestMessage,
  TrackerSetConfigMessage,
  TrackerPingMessage,
  TrackerSyncResponseMessage,
  TrackerDeltaMessage,
  TrackerMutationAckMessage,
  TrackerMutationRejectCode,
  TrackerConfigBroadcastMessage,
  TrackerPongMessage,
  TrackerErrorMessage,
  TrackerRoomConfig,
  TrackerTransactionState,
  TrackerTransactionRow,
  TrackerItemRow,
  TrackerBodyCacheRow,
} from './trackerProtocol';

export {
  buildTrackerRoomId,
  stripLocalOnlyFields,
  LOCAL_ONLY_PAYLOAD_FIELDS,
  SYNC_ID_INITIAL,
} from './trackerProtocol';

export {
  encryptTrackerPayload,
  decryptTrackerEnvelope,
  fingerprintTrackerKey,
} from './TrackerEnvelopeCrypto';

export {
  InMemoryTrackerPersistence,
} from './trackerPersistence';

export type {
  TrackerPersistence,
  TrackerRowSnapshot,
} from './trackerPersistence';

export {
  applyLabelDiff,
  mergeLabelMaps,
  normalizeLegacyLabelValues,
  projectLabelsToValues,
} from './trackerLabels';

export type {
  LabelsMap,
} from './trackerLabels';

export { HeadlessLexicalYDoc } from './HeadlessLexicalYDoc';
export type { HeadlessLexicalYDocOptions } from './HeadlessLexicalYDoc';

export { MarkdownCollabContentAdapter } from './MarkdownCollabContentAdapter';
export {
  createRevisionAdapterFromCollabContent,
  type CollabAdapterRevisionBridgeOptions,
} from './revisionSnapshotBridge';

export {
  TrackerSyncEngine,
} from './TrackerSyncEngine';

export type {
  TrackerSyncEngineConfig,
  TrackerSyncStatus,
  TrackerKeyMaterial,
  AppliedTrackerItem,
  RejectedTrackerMutation,
} from './TrackerSyncEngine';

export {
  TeamSyncProvider,
} from './TeamSync';

export type {
  TeamSyncConfig,
  TeamSyncStatus,
  TeamState,
  MemberInfo as TeamMemberInfo,
  KeyEnvelopeData,
  DocIndexEntry as TeamDocIndexEntry,
} from './teamSyncTypes';

export {
  ProjectSyncProvider,
} from './ProjectSyncProvider';

export type {
  ProjectSyncConfig,
  ProjectSyncFileUpdate,
  ProjectSyncManifestFile,
  ProjectSyncResponse,
} from './ProjectSyncProvider';
