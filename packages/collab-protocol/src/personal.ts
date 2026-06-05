/**
 * PersonalSessionRoom + PersonalIndexRoom wire protocol.
 *
 * Session sync, session index, device presence, mobile push, settings sync.
 * All three concerns share one WebSocket message router on the client side
 * and one `ClientMessage` / `ServerMessage` union here.
 */

import type {
  InboxSyncRequestMessage,
  MarkInboxReadMessage,
  InboxSyncResponseMessage,
  InboxEventBroadcastMessage,
  MarkInboxReadResponseMessage,
} from './inbox.js';

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type ClientMessage =
  | SyncRequestMessage
  | AppendMessageMessage
  | UpdateMetadataMessage
  | DeleteSessionMessage
  | IndexSyncRequestMessage
  | IndexUpdateMessage
  | IndexClientMetadataPatchMessage
  | IndexBatchUpdateMessage
  | IndexDeleteMessage
  | FileIndexUpdateMessage
  | FileIndexDeleteMessage
  | DeviceAnnounceMessage
  | CreateSessionRequestMessage
  | CreateSessionResponseMessage
  | CreateWorktreeRequestMessage
  | CreateWorktreeResponseMessage
  | SessionControlCommandMessage
  | RegisterPushTokenMessage
  | UnregisterPushTokenMessage
  | RequestMobilePushMessage
  | ProjectConfigUpdateMessage
  | SettingsSyncMessage
  | InboxSyncRequestMessage
  | MarkInboxReadMessage
  | PingMessage;

/** Keep-alive ping message */
export interface PingMessage {
  type: 'ping';
}

/** Request messages since a cursor */
export interface SyncRequestMessage {
  type: 'syncRequest';
  sinceId?: string;
  sinceSeq?: number;
}

/** Append a new message to the session */
export interface AppendMessageMessage {
  type: 'appendMessage';
  message: EncryptedMessage;
}

/** Update session metadata */
export interface UpdateMetadataMessage {
  type: 'updateMetadata';
  metadata: Partial<SessionMetadata>;
}

/** Delete a session */
export interface DeleteSessionMessage {
  type: 'deleteSession';
}

/** Request index sync. If `since` is provided, only returns entries updated after that timestamp. */
export interface IndexSyncRequestMessage {
  type: 'indexSyncRequest';
  projectId?: string;
  /** Unix ms timestamp. When set, server returns only sessions/projects updated after this time. */
  since?: number;
}

/** Update session in index (from desktop after local change) */
export interface IndexUpdateMessage {
  type: 'indexUpdate';
  session: SessionIndexEntry;
}

/**
 * Patch metadata-only session index fields without touching updated_at or
 * forcing a project stats recalculation.
 */
export interface IndexClientMetadataPatchMessage {
  type: 'indexClientMetadataPatch';
  patch: IndexClientMetadataPatch;
}

export interface IndexClientMetadataPatch {
  sessionId: string;
  /** Encrypted client metadata blob (base64) - opaque to server */
  encryptedClientMetadata?: string;
  /** IV for client metadata decryption (base64) */
  clientMetadataIv?: string;
  /** Whether the session is currently executing (processing AI request) */
  isExecuting?: boolean;
  /** Unix timestamp ms when this session was last read by any device */
  lastReadAt?: number;
}

/** Batch update sessions in index (for efficient bulk sync) */
export interface IndexBatchUpdateMessage {
  type: 'indexBatchUpdate';
  sessions: SessionIndexEntry[];
}

/** Delete session from index */
export interface IndexDeleteMessage {
  type: 'indexDelete';
  sessionId: string;
}

/** Update or insert a file in the file index */
export interface FileIndexUpdateMessage {
  type: 'fileIndexUpdate';
  file: FileIndexEntry;
}

/** Delete a file from the file index */
export interface FileIndexDeleteMessage {
  type: 'fileIndexDelete';
  docId: string;
}

/** Announce device presence and info */
export interface DeviceAnnounceMessage {
  type: 'deviceAnnounce';
  device: DeviceInfo;
}

/** Request session creation from mobile to desktop */
export interface CreateSessionRequestMessage {
  type: 'createSessionRequest';
  request: EncryptedCreateSessionRequest;
}

/** Response to session creation request from desktop */
export interface CreateSessionResponseMessage {
  type: 'createSessionResponse';
  response: EncryptedCreateSessionResponse;
}

/** Encrypted session creation request (sent over wire) */
export interface EncryptedCreateSessionRequest {
  requestId: string;
  /** Encrypted project ID (base64) - required for wire protocol */
  encryptedProjectId: string;
  /** IV for project_id decryption (base64) */
  projectIdIv: string;
  /** Base64 encoded encrypted initial prompt (optional) */
  encryptedInitialPrompt?: string;
  /** Base64 encoded IV for initial prompt decryption */
  initialPromptIv?: string;
  /** Session type: "session" (default), "workstream" (parent container) */
  sessionType?: string;
  /** Parent session ID for creating child sessions within a workstream */
  parentSessionId?: string;
  /** Provider ID selected by mobile (e.g., "claude-code") */
  provider?: string;
  /** Model ID selected by mobile (e.g., "claude-code:opus") */
  model?: string;
  timestamp: number;
}

/** Encrypted session creation response (sent over wire) */
export interface EncryptedCreateSessionResponse {
  requestId: string;
  success: boolean;
  sessionId?: string;
  error?: string;
}

/** Request worktree creation from mobile to desktop */
export interface CreateWorktreeRequestMessage {
  type: 'createWorktreeRequest';
  request: EncryptedCreateWorktreeRequest;
}

/** Response to worktree creation request from desktop */
export interface CreateWorktreeResponseMessage {
  type: 'createWorktreeResponse';
  response: EncryptedCreateWorktreeResponse;
}

/** Encrypted worktree creation request (sent over wire) */
export interface EncryptedCreateWorktreeRequest {
  requestId: string;
  encryptedProjectId: string;
  projectIdIv: string;
  timestamp: number;
}

/** Encrypted worktree creation response (sent over wire) */
export interface EncryptedCreateWorktreeResponse {
  requestId: string;
  success: boolean;
  error?: string;
}

/** Generic session control command - the sync layer just passes these through */
export interface SessionControlCommandMessage {
  type: 'sessionControl';
  message: SessionControlMessage;
}

/** Generic session control message payload */
export interface SessionControlMessage {
  sessionId: string;
  /** Message type - receiver decides how to handle */
  messageType: string;
  /** Arbitrary payload - receiver interprets based on messageType */
  payload?: Record<string, unknown>;
  timestamp: number;
  sentBy: 'desktop' | 'mobile';
}

/** Register a push notification token for this device */
export interface RegisterPushTokenMessage {
  type: 'registerPushToken';
  token: string;
  platform: 'ios' | 'android';
  deviceId: string;
}

/** Remove the registered push notification token for this device */
export interface UnregisterPushTokenMessage {
  type: 'unregisterPushToken';
  deviceId: string;
}

/** Request to send a push notification to mobile devices */
export interface RequestMobilePushMessage {
  type: 'requestMobilePush';
  sessionId: string;
  title: string;
  body: string;
  /** Device ID of the requesting device, used for active-device routing */
  requestingDeviceId?: string;
}

/** Update project config (encrypted blob with commands, etc.) */
export interface ProjectConfigUpdateMessage {
  type: 'projectConfigUpdate';
  /** Encrypted project ID (must match existing project_index entry) */
  encryptedProjectId: string;
  projectIdIv: string;
  /** Encrypted project config blob (base64 AES-GCM). Optional when only updating gitRemoteHash. */
  encryptedConfig?: string;
  /** IV for config decryption (base64) */
  configIv?: string;
  /** SHA-256 hash of the git remote URL (plaintext, used for ProjectSyncRoom routing) */
  gitRemoteHash?: string;
}

/** Sync encrypted settings to other devices */
export interface SettingsSyncMessage {
  type: 'settingsSync';
  settings: EncryptedSettingsPayload;
}

/** Encrypted settings payload for wire transmission */
export interface EncryptedSettingsPayload {
  /** Encrypted JSON blob containing settings (base64) */
  encryptedSettings: string;
  /** IV for settings decryption (base64) */
  settingsIv: string;
  /** Device ID of sender */
  deviceId: string;
  /** Timestamp of settings sync */
  timestamp: number;
  /** Version for handling upgrades */
  version: number;
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type ServerMessage =
  | SyncResponseMessage
  | MessageBroadcastMessage
  | MetadataBroadcastMessage
  | IndexSyncResponseMessage
  | IndexBroadcastMessage
  | IndexDeleteBroadcastMessage
  | ProjectBroadcastMessage
  | FileIndexBroadcastMessage
  | FileIndexDeleteBroadcastMessage
  | DevicesListMessage
  | DeviceJoinedMessage
  | DeviceLeftMessage
  | CreateSessionRequestBroadcastMessage
  | CreateSessionResponseBroadcastMessage
  | CreateWorktreeRequestBroadcastMessage
  | CreateWorktreeResponseBroadcastMessage
  | SessionControlBroadcastMessage
  | SettingsSyncBroadcastMessage
  | InboxSyncResponseMessage
  | InboxEventBroadcastMessage
  | MarkInboxReadResponseMessage
  | ErrorMessage;

/** Response to syncRequest */
export interface SyncResponseMessage {
  type: 'syncResponse';
  messages: EncryptedMessage[];
  metadata: SessionMetadata | null;
  hasMore: boolean;
  cursor: string | null;
}

/** Broadcast new message to other devices */
export interface MessageBroadcastMessage {
  type: 'messageBroadcast';
  message: EncryptedMessage;
  fromConnectionId?: string;
}

/** Broadcast metadata change to other devices */
export interface MetadataBroadcastMessage {
  type: 'metadataBroadcast';
  metadata: Partial<SessionMetadata>;
  fromConnectionId?: string;
}

/** Response to indexSyncRequest */
export interface IndexSyncResponseMessage {
  type: 'indexSyncResponse';
  sessions: SessionIndexEntry[];
  projects: ProjectIndexEntry[];
  files?: FileIndexEntry[];
  /** Total session count from COUNT(*) - used to detect if toArray() truncated results */
  totalSessionCount?: number;
  /** Echo of the `since` value from the request. Present only for incremental responses. */
  since?: number;
}

/** Broadcast index update to other devices */
export interface IndexBroadcastMessage {
  type: 'indexBroadcast';
  session: SessionIndexEntry;
  fromConnectionId?: string;
}

/** Broadcast session deletion to other devices */
export interface IndexDeleteBroadcastMessage {
  type: 'indexDeleteBroadcast';
  sessionId: string;
  fromConnectionId?: string;
}

/** Broadcast project update (new or updated) to other devices */
export interface ProjectBroadcastMessage {
  type: 'projectBroadcast';
  project: ProjectIndexEntry;
  fromConnectionId?: string;
}

/** Broadcast file index update to other devices */
export interface FileIndexBroadcastMessage {
  type: 'fileIndexBroadcast';
  file: FileIndexEntry;
  fromConnectionId?: string;
}

/** Broadcast file index deletion to other devices */
export interface FileIndexDeleteBroadcastMessage {
  type: 'fileIndexDeleteBroadcast';
  docId: string;
  fromConnectionId?: string;
}

/** List of currently connected devices (sent on connect and device changes) */
export interface DevicesListMessage {
  type: 'devicesList';
  devices: DeviceInfo[];
}

/** Broadcast when a device joins */
export interface DeviceJoinedMessage {
  type: 'deviceJoined';
  device: DeviceInfo;
}

/** Broadcast when a device leaves */
export interface DeviceLeftMessage {
  type: 'deviceLeft';
  deviceId: string;
}

/** Broadcast session creation request to other devices (desktop receives this) */
export interface CreateSessionRequestBroadcastMessage {
  type: 'createSessionRequestBroadcast';
  request: EncryptedCreateSessionRequest;
  fromConnectionId?: string;
}

/** Broadcast session creation response to other devices (mobile receives this) */
export interface CreateSessionResponseBroadcastMessage {
  type: 'createSessionResponseBroadcast';
  response: EncryptedCreateSessionResponse;
  fromConnectionId?: string;
}

/** Broadcast worktree creation request to other devices (desktop receives this) */
export interface CreateWorktreeRequestBroadcastMessage {
  type: 'createWorktreeRequestBroadcast';
  request: EncryptedCreateWorktreeRequest;
  fromConnectionId?: string;
}

/** Broadcast worktree creation response to other devices (mobile receives this) */
export interface CreateWorktreeResponseBroadcastMessage {
  type: 'createWorktreeResponseBroadcast';
  response: EncryptedCreateWorktreeResponse;
  fromConnectionId?: string;
}

/** Broadcast generic session control message to other devices */
export interface SessionControlBroadcastMessage {
  type: 'sessionControlBroadcast';
  message: SessionControlMessage;
  fromConnectionId?: string;
}

/** Broadcast encrypted settings to other devices (mobile receives this) */
export interface SettingsSyncBroadcastMessage {
  type: 'settingsSyncBroadcast';
  settings: EncryptedSettingsPayload;
  fromConnectionId?: string;
}

/** Error response */
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

// ============================================================================
// Data Types
// ============================================================================

/**
 * Information about a connected device.
 * Used for device awareness/presence in the PersonalIndexRoom.
 */
export interface DeviceInfo {
  /** Unique device ID (stable across sessions, generated per device) */
  deviceId: string;
  /** Human-readable device name (e.g., "MacBook Pro", "iPhone 15") */
  name: string;
  /** Device type for icon display */
  type: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  /** Platform (e.g., "macos", "ios", "windows", "android", "web") */
  platform: string;
  /** App version */
  appVersion?: string;
  /** When this device connected (Unix timestamp ms) */
  connectedAt: number;
  /** Last activity timestamp (Unix timestamp ms) - updated on user interaction */
  lastActiveAt: number;
  /** Whether the app window is currently focused (optional for backwards compatibility) */
  isFocused?: boolean;
  /** Derived status for presence display (optional for backwards compatibility) */
  status?: 'active' | 'idle' | 'away';
  /** Whether the device is currently connected (set by server, not by client) */
  isOnline?: boolean;
  /** When this device was last seen online (Unix timestamp ms, set by server on disconnect) */
  lastSeenAt?: number;
}

/**
 * Encrypted message as stored on server.
 * Content is E2E encrypted - server only sees ciphertext.
 */
export interface EncryptedMessage {
  /** ULID for global ordering */
  id: string;
  /** Monotonic sequence within session */
  sequence: number;
  /** Unix timestamp ms */
  createdAt: number;
  /** Message source */
  source: 'user' | 'assistant' | 'tool' | 'system';
  /** Direction of message */
  direction: 'input' | 'output';
  /** Base64 encoded encrypted content */
  encryptedContent: string;
  /** Base64 encoded IV for decryption */
  iv: string;
  /** Empty metadata object (all sensitive data is in encrypted_content) */
  metadata: Record<string, never>;
}

/**
 * Session metadata (stored alongside messages in PersonalSessionRoom).
 *
 * Titles are E2E encrypted: clients send `encryptedTitle` + `titleIv`, the
 * server stores ciphertext only, and clients decrypt for display. There is
 * no plaintext `title` on this interface by design -- a plaintext title
 * would leak into DO SQLite where the server (and anyone with admin access
 * to the DO) could read it.
 */
export interface SessionMetadata {
  /** Encrypted title (base64, AES-GCM) */
  encryptedTitle?: string;
  /** IV for title decryption (base64) */
  titleIv?: string;
  provider: string;
  model?: string;
  mode?: 'agent' | 'planning';
  /** Encrypted project ID (base64) - required for wire protocol */
  encryptedProjectId: string;
  /** IV for project_id decryption (base64) */
  projectIdIv: string;
  createdAt: number;
  updatedAt: number;
  /** Whether the session is currently executing (processing AI request) */
  isExecuting?: boolean;
}

/** Session entry in the PersonalIndexRoom */
export interface SessionIndexEntry {
  sessionId: string;
  /** Encrypted project ID (base64) - required for wire protocol */
  encryptedProjectId: string;
  /** IV for project_id decryption (base64) */
  projectIdIv: string;
  /** Encrypted title (base64) */
  encryptedTitle?: string;
  /** IV for title decryption (base64) */
  titleIv?: string;
  provider: string;
  model?: string;
  mode?: 'agent' | 'planning';
  messageCount: number;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
  /** Whether the session is currently executing (processing AI request) */
  isExecuting?: boolean;
  /** Parent session ID for workstream/worktree hierarchy (plaintext UUID) */
  parentSessionId?: string;
  /** Structural type: 'session' (normal), 'workstream' (parent container), 'blitz' (quick task) */
  sessionType?: string;
  /** Worktree ID for git worktree association (plaintext UUID) */
  worktreeId?: string;
  /** Whether the session is archived */
  isArchived?: boolean;
  /** Whether the session is pinned */
  isPinned?: boolean;
  /** Session ID this was branched/forked from */
  branchedFromSessionId?: string;
  /** Message ID at the branch point */
  branchPointMessageId?: number;
  /** When this session was branched (unix ms) */
  branchedAt?: number;
  /** Encrypted client metadata blob (base64) - opaque to server, decrypted by clients */
  encryptedClientMetadata?: string;
  /** IV for client metadata decryption (base64) */
  clientMetadataIv?: string;
  /** Unix timestamp ms when this session was last read by any device */
  lastReadAt?: number;
}

/** Project entry in the PersonalIndexRoom */
export interface ProjectIndexEntry {
  /** Encrypted project ID (base64) - required for wire protocol */
  encryptedProjectId: string;
  /** IV for project_id decryption (base64) */
  projectIdIv: string;
  /** Encrypted project name (base64) - required for wire protocol */
  encryptedName: string;
  /** IV for name decryption (base64) */
  nameIv: string;
  /** Encrypted project path (base64) - optional */
  encryptedPath?: string;
  /** IV for path decryption (base64) */
  pathIv?: string;
  sessionCount: number;
  lastActivityAt: number;
  syncEnabled: boolean;
  /** Encrypted project config blob (base64) - contains commands, settings, etc. */
  encryptedConfig?: string;
  /** IV for config decryption (base64) */
  configIv?: string;
  /** SHA-256 hash of the git remote URL (plaintext, used for ProjectSyncRoom routing) */
  gitRemoteHash?: string;
}

/** File index entry for mobile markdown sync */
export interface FileIndexEntry {
  /** Document sync ID from frontmatter (plaintext, used as document room key) */
  docId: string;
  /** Encrypted project ID (base64) */
  encryptedProjectId: string;
  /** IV for project_id decryption (base64) */
  projectIdIv: string;
  /** Encrypted relative path (base64) e.g. "notes/meeting.md" */
  encryptedRelativePath: string;
  /** IV for relative_path decryption (base64) */
  relativePathIv: string;
  /** Encrypted title/filename (base64) */
  encryptedTitle: string;
  /** IV for title decryption (base64) */
  titleIv: string;
  /** Last modified timestamp (ms) */
  lastModifiedAt: number;
  /** Last time desktop pushed Yjs state (ms) */
  syncedAt: number;
}
