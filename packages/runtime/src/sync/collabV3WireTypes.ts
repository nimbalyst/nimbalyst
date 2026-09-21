/**
 * CollabV3 wire types.
 *
 * The message shapes the desktop provider exchanges with the collab worker and
 * the iOS client, hand-mirrored against `SyncProtocol.swift` and the server.
 * Lifted out of CollabV3Sync.ts unchanged so the protocol fixtures can
 * compile-check against them without importing the provider.
 */

import type { AgentMessage } from '../ai/server/types';
import type {
  DeviceInfo,
  EncryptedAttachment,
  EncryptedReadReceiptPayload,
  EncryptedSettingsPayload,
  EncryptedTrackerPersonalStatePayload,
  MobilePushResult,
  SyncStatus,
  SyncedSettings,
} from './types';
import type {
  FileIndexBroadcastMessage,
  FileIndexDeleteBroadcastMessage,
  FleetActivitySnapshot,
  IndexDeleteBroadcastMessage,
  PushRejectionCause,
} from '@nimbalyst/collab-protocol';
import type { IndexPageRequestInput } from './indexReplicationClient';

// ============================================================================
// CollabV3 Protocol Types (matches server)
// ============================================================================

export interface EncryptedMessage {
  id: string;
  sequence: number;
  createdAt: number;
  source: 'user' | 'assistant' | 'tool' | 'system';
  direction: 'input' | 'output';
  encryptedContent: string;
  iv: string;
  /**
   * Opaque passthrough. The desktop writes `{}`, the server round-trips it as
   * `metadata_json` without inspecting it, and no client reads it -- the
   * per-message metadata clients actually use travels INSIDE the encrypted
   * content. The previous `tool_name` / `has_attachments` / `content_length`
   * keys had no producer or consumer anywhere. Nullable because the server's
   * `metadata_json` column is.
   */
  metadata: EncryptedMessageMetadata | null;
}

/** See `EncryptedMessage.metadata`: opaque, unread, kept only for round-trip. */
export type EncryptedMessageMetadata = Record<string, unknown>;

/** Encrypted queued prompt for wire protocol */
export interface EncryptedQueuedPrompt {
  options?: import("./types").RemoteTurnOptions;
  id: string;
  /** Encrypted prompt text (base64) */
  encryptedPrompt: string;
  /** IV for prompt decryption (base64) */
  iv: string;
  timestamp: number;
  /** Encrypted image attachments from mobile (each independently encrypted) */
  encryptedAttachments?: WireEncryptedAttachment[];
}

/** An encrypted image attachment on the wire */
export interface WireEncryptedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  /** Base64 AES-GCM ciphertext of the compressed image data */
  encryptedData: string;
  /** Base64 IV for decryption */
  iv: string;
  /** Original size in bytes (before encryption) */
  size: number;
  width?: number;
  height?: number;
}

/** Plaintext queued prompt (after decryption) */
export interface PlaintextQueuedPrompt {
  options?: import("./types").RemoteTurnOptions;
  id: string;
  prompt: string;
  timestamp: number;
  /** Decrypted image attachments from mobile */
  attachments?: EncryptedAttachment[];
}

export interface SessionMetadata {
  /** Encrypted title (base64) */
  encryptedTitle?: string;
  /** IV for title decryption (base64) */
  titleIv?: string;
  /** Plaintext title (for local cache / pre-encryption) */
  title?: string;
  provider: string;
  model?: string;
  mode?: 'agent' | 'planning';
  /** Encrypted project ID (base64) - required for wire protocol */
  encryptedProjectId: string;
  /** IV for projectId decryption (base64) */
  projectIdIv: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Dead field. Nothing anywhere assigns it: no producer in runtime, electron,
   * iOS or the collab server, and `@nimbalyst/collab-protocol` does not declare
   * it at all. The server has never persisted it; iOS decodes it once
   * (`SyncProtocol.swift`) and never reads it. Every reference in this file is
   * a pass-through copy of a value that is always `undefined`.
   *
   * Deliberately NOT part of the v2 parity set: it needs no clear contract
   * (`null` vs absent vs object) and no server persistence, because there is
   * nothing to clear. Left in place rather than removed so the legacy wire
   * shape is untouched. If a real producer ever appears, define the clear
   * semantics THEN, together with the consumer that needs them.
   */
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  isExecuting?: boolean;
  /** Encrypted queued prompts */
  encryptedQueuedPrompts?: EncryptedQueuedPrompt[];
  /** Encrypted client metadata blob (base64) - opaque to server */
  encryptedClientMetadata?: string;
  /** IV for client metadata decryption (base64) */
  clientMetadataIv?: string;
}

export interface SessionIndexEntry {
  sessionId: string;
  /** Encrypted project ID (base64) - required for wire protocol */
  encryptedProjectId: string;
  /** IV for projectId decryption (base64) */
  projectIdIv: string;
  /** Encrypted title (base64) */
  encryptedTitle?: string;
  /** IV for title decryption (base64) */
  titleIv?: string;
  /** Plaintext title (for local cache / pre-encryption) */
  title?: string;
  provider: string;
  model?: string;
  mode?: 'agent' | 'planning';
  /** Structural type: 'session' | 'workstream' | 'blitz' */
  sessionType?: string;
  /** Parent session ID for workstream/worktree hierarchy (plaintext UUID) */
  parentSessionId?: string;
  /** Worktree ID for git worktree association (plaintext UUID) */
  worktreeId?: string;
  /** Stable device ID of the host that owns this session. */
  hostDeviceId?: string;
  /** Agent role marker (e.g. 'meta-agent', 'standard'). Plaintext - drives mobile meta-agent grouping. */
  agentRole?: string;
  /** Meta-agent parent session ID for spawned children (plaintext UUID). Drives mobile meta-agent grouping. */
  createdBySessionId?: string;
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
  /**
   * Omitted when the sender does not know the count. The server COALESCEs an
   * omitted count with the stored one, so a metadata-only publish no longer
   * overwrites the real count with a synthetic zero.
   */
  messageCount?: number;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  /** Whether the session is currently executing (processing AI request) */
  isExecuting?: boolean;
  /** Number of prompts queued from mobile, waiting for desktop to process */
  queuedPromptCount?: number;
  /** Encrypted queued prompts */
  encryptedQueuedPrompts?: EncryptedQueuedPrompt[];
  /** Whether there are pending interactive prompts (permissions or questions) waiting for response */
  hasPendingPrompt?: boolean;
  /** Encrypted client metadata blob (base64) - opaque to server */
  encryptedClientMetadata?: string;
  /** IV for client metadata decryption (base64) */
  clientMetadataIv?: string;
  /** Unix timestamp ms when this session was last read by any device */
  lastReadAt?: number;
}

/** Decrypted session index entry with required title and projectId - used for return values */
export type DecryptedSessionIndexEntry = Omit<SessionIndexEntry, 'title' | 'encryptedTitle' | 'titleIv' | 'encryptedProjectId' | 'projectIdIv' | 'encryptedQueuedPrompts' | 'encryptedClientMetadata' | 'clientMetadataIv' | 'messageCount'> & {
  title: string;  // Required after decryption
  projectId: string;  // Decrypted project ID
  /** Optional on the wire (omitted = "keep what you have"); always concrete here. */
  messageCount: number;
  queuedPrompts?: PlaintextQueuedPrompt[];  // Decrypted queued prompts
  currentContext?: { tokens: number; contextWindow: number };  // Decrypted from client metadata
  hasBeenNamed?: boolean;  // Decrypted from client metadata
};

/** Encrypted create session request for wire protocol */
export interface EncryptedCreateSessionRequest {
  requestId: string;
  /** Encrypted project ID (base64) - required for wire protocol */
  encryptedProjectId: string;
  /** IV for projectId decryption (base64) */
  projectIdIv: string;
  /** Encrypted initial prompt (base64), optional */
  encryptedInitialPrompt?: string;
  /** IV for prompt decryption (base64), required if encryptedInitialPrompt present */
  initialPromptIv?: string;
  /** Session type: "session" (default), "workstream" (parent container) */
  sessionType?: string;
  /** Parent session ID for creating child sessions within a workstream */
  parentSessionId?: string;
  /** Provider ID selected by mobile (e.g., "claude-code") */
  provider?: string;
  /** Model ID selected by mobile (e.g., "claude-code:opus") */
  model?: string;
  /** Agent role (e.g., "meta-agent", "standard"). Plaintext - no encryption needed. */
  agentRole?: string;
  timestamp: number;
}

/** Encrypted create session response for wire protocol */
export interface EncryptedCreateSessionResponse {
  requestId: string;
  success: boolean;
  sessionId?: string;
  error?: string;
}

/** Encrypted worktree creation request for wire protocol */
export interface EncryptedCreateWorktreeRequest {
  requestId: string;
  encryptedProjectId: string;
  projectIdIv: string;
  timestamp: number;
}

/** Encrypted worktree creation response for wire protocol */
export interface EncryptedCreateWorktreeResponse {
  requestId: string;
  success: boolean;
  error?: string;
}

/** Encrypted voice-tool request for wire protocol (toolName/args carry project knowledge). */
export interface EncryptedVoiceToolRequest {
  requestId: string;
  encryptedProjectId: string;
  projectIdIv: string;
  encryptedToolName: string;
  toolNameIv: string;
  encryptedArgs: string;
  argsIv: string;
  timestamp: number;
}

/** Encrypted voice-tool response for wire protocol. */
export interface EncryptedVoiceToolResponse {
  requestId: string;
  success: boolean;
  encryptedResult?: string;
  resultIv?: string;
  encryptedError?: string;
  errorIv?: string;
}

export interface IndexClientMetadataPatch {
  sessionId: string;
  encryptedClientMetadata?: string;
  clientMetadataIv?: string;
  isExecuting?: boolean;
  lastReadAt?: number;
}

export type ClientMessage =
  | { type: 'syncRequest'; sinceId?: string; sinceSeq?: number }
  | { type: 'appendMessage'; message: EncryptedMessage }
  | { type: 'updateMetadata'; metadata: Partial<SessionMetadata> }
  | { type: 'deleteSession' }
  | { type: 'indexSyncRequest'; projectId?: string }
  | { type: 'indexUpdate'; session: SessionIndexEntry }
  | { type: 'indexClientMetadataPatch'; patch: IndexClientMetadataPatch }
  | { type: 'indexBatchUpdate'; sessions: SessionIndexEntry[] }
  | { type: 'indexDelete'; sessionId: string }
  | { type: 'deviceAnnounce'; device: DeviceInfo }
  | { type: 'createSessionRequest'; request: EncryptedCreateSessionRequest; targetDeviceId?: string }
  | { type: 'createSessionResponse'; response: EncryptedCreateSessionResponse }
  | { type: 'createWorktreeRequest'; request: EncryptedCreateWorktreeRequest; targetDeviceId?: string }
  | { type: 'createWorktreeResponse'; response: EncryptedCreateWorktreeResponse }
  | { type: 'voiceToolRequest'; request: EncryptedVoiceToolRequest }
  | { type: 'voiceToolResponse'; response: EncryptedVoiceToolResponse }
  | { type: 'sessionControl'; message: { sessionId: string; messageType: string; payload?: Record<string, unknown>; timestamp: number; sentBy: 'desktop' | 'mobile'; sentByDeviceId?: string; targetDeviceId?: string } }
  | {
      type: 'requestMobilePush';
      sessionId: string;
      title: string;
      body: string;
      requestingDeviceId?: string;
      requestId?: string;
      force?: boolean;
      reason?: string;
    }
  | { type: 'fleetActivityUpdate'; activity: FleetActivitySnapshot; shownOnDesktop?: boolean }
  | { type: 'settingsSync'; settings: EncryptedSettingsPayload }
  | { type: 'readReceipt'; receipt: EncryptedReadReceiptPayload }
  | { type: 'trackerPersonalState'; state: EncryptedTrackerPersonalStatePayload }
  | { type: 'fileIndexUpdate'; file: EncryptedFileIndexEntry }
  | { type: 'fileIndexDelete'; docId: string }
  | ({ type: 'indexPageRequest'; protocolVersion: 2; requestId: string } & IndexPageRequestInput)
  | { type: 'personalStatePageRequest'; requestId: string; pageToken?: string; limit?: number };

/**
 * One row of a v2 index page, still encrypted. Shape is fixed by
 * `@nimbalyst/collab-protocol/indexReplication.ts`; spelled out here against
 * this file's own wire types the same way the rest of `ServerMessage` is.
 */
export interface IndexChangeWire {
  removalReason?: 'expired' | 'deleted';
  entity: 'session' | 'project' | 'file';
  id: string;
  revision: number;
  deleted: boolean;
  session?: SessionIndexEntry;
  project?: ServerProjectEntry;
  file?: EncryptedFileIndexEntry;
}

/**
 * Independent bounded replay of the personal-state streams. Shape is fixed by
 * `@nimbalyst/collab-protocol/indexReplication.ts`; these pages carry no
 * revisions and never establish index coverage.
 */
export interface PersonalStatePageResponseWire {
  type: 'personalStatePageResponse';
  requestId: string;
  entries: Array<
    | { type: 'readReceiptBroadcast'; receipt: EncryptedReadReceiptPayload; fromConnectionId?: string }
    | { type: 'trackerPersonalStateBroadcast'; state: EncryptedTrackerPersonalStatePayload; fromConnectionId?: string }
  >;
  nextPageToken?: string;
  complete: boolean;
}

export interface IndexPageResponseWire {
  type: 'indexPageResponse';
  protocolVersion: 2;
  requestId: string;
  mode: 'bootstrap' | 'delta' | 'recent' | 'lookup';
  entries: IndexChangeWire[];
  nextPageToken?: string;
  cursor?: number;
  complete: boolean;
  resetRequired?: boolean;
}

/**
 * Thrown when the server does not understand `indexPageRequest`. Distinct from
 * every other failure because it -- and only it -- authorizes the legacy
 * full-index fallback. A transport error or a partial bootstrap must never be
 * laundered into "use the old path and carry on".
 */
export class IndexProtocolUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexProtocolUnsupportedError';
  }
}

/** Encrypted file index entry for wire protocol */
export interface EncryptedFileIndexEntry {
  docId: string;
  encryptedProjectId: string;
  projectIdIv: string;
  encryptedRelativePath: string;
  relativePathIv: string;
  encryptedTitle: string;
  titleIv: string;
  lastModifiedAt: number;
  syncedAt: number;
}

/** Encrypted project index entry from server */
export interface ServerProjectEntry {
  encryptedProjectId: string;
  projectIdIv: string;
  encryptedName: string;
  nameIv: string;
  encryptedPath?: string;
  pathIv?: string;
  sessionCount: number;
  lastActivityAt: number;
  syncEnabled: boolean;
  gitRemoteHash?: string;
}

export type ServerMessage =
  | { type: 'indexSessionExpired'; sessionId: string; activityAt: number }
  | { type: 'syncResponse'; messages: EncryptedMessage[]; metadata: SessionMetadata | null; hasMore: boolean; cursor: string | null }
  | { type: 'messageBroadcast'; message: EncryptedMessage; fromConnectionId?: string }
  | { type: 'metadataBroadcast'; metadata: Partial<SessionMetadata>; fromConnectionId?: string }
  | { type: 'indexSyncResponse'; sessions: SessionIndexEntry[]; projects: ServerProjectEntry[] }
  | { type: 'indexBroadcast'; session: SessionIndexEntry; fromConnectionId?: string }
  // Reused from the shared protocol package rather than re-declared: these three
  // are emitted by IndexRoom (session delete and TTL cleanup at IndexRoom.ts:1311
  // and :2767, file upsert at :1356, file delete at :1379) and were simply
  // missing from this union. The desktop switch has no case for any of them and
  // no default branch, so it ignores all three today; iOS decodes
  // indexDeleteBroadcast. Typed here only so the fixtures can see them.
  // Keep-alive answer to a client `ping` (IndexRoom.ts:857). Not a broadcast,
  // but it is a server message this union lacked. Deliberately excluded from
  // the golden fixtures: iOS keeps the socket alive with URLSession control
  // frames and never decodes a JSON pong, so there is no second side to pin.
  | { type: 'pong' }
  | IndexDeleteBroadcastMessage
  | FileIndexBroadcastMessage
  | FileIndexDeleteBroadcastMessage
  | { type: 'projectBroadcast'; project: ServerProjectEntry; fromConnectionId?: string }
  | { type: 'devicesList'; devices: DeviceInfo[] }
  | { type: 'deviceJoined'; device: DeviceInfo }
  | { type: 'deviceLeft'; deviceId: string }
  | { type: 'createSessionRequestBroadcast'; request: EncryptedCreateSessionRequest; targetDeviceId?: string; fromConnectionId?: string }
  | { type: 'createSessionResponseBroadcast'; response: EncryptedCreateSessionResponse; fromConnectionId?: string }
  | { type: 'createWorktreeRequestBroadcast'; request: EncryptedCreateWorktreeRequest; targetDeviceId?: string; fromConnectionId?: string }
  | { type: 'createWorktreeResponseBroadcast'; response: EncryptedCreateWorktreeResponse; fromConnectionId?: string }
  | { type: 'voiceToolRequestBroadcast'; request: EncryptedVoiceToolRequest; fromConnectionId?: string }
  | { type: 'voiceToolResponseBroadcast'; response: EncryptedVoiceToolResponse; fromConnectionId?: string }
  | { type: 'sessionControlBroadcast'; message: { sessionId: string; messageType: string; payload?: Record<string, unknown>; timestamp: number; sentBy: 'desktop' | 'mobile'; sentByDeviceId?: string; targetDeviceId?: string }; fromConnectionId?: string }
  | { type: 'settingsSyncBroadcast'; settings: EncryptedSettingsPayload; fromConnectionId?: string }
  | { type: 'readReceiptBroadcast'; receipt: EncryptedReadReceiptPayload; fromConnectionId?: string }
  | { type: 'trackerPersonalStateBroadcast'; state: EncryptedTrackerPersonalStatePayload; fromConnectionId?: string }
  | ({ type: 'mobilePushResult'; requestId: string; sessionId: string } & MobilePushResult)
  | IndexPageResponseWire
  | PersonalStatePageResponseWire
  // Wake-up hint only. It carries the server's newest revision so the client can
  // skip a pointless poll; it is never an applied cursor and never evidence
  // that the local mirror covers that revision.
  | { type: 'indexChangesAvailable'; revision: number }
  | { type: 'error'; code: string; message: string; requestId?: string };

/**
 * Client metadata that gets encrypted and synced opaquely through the server.
 * The server never reads this — only clients encrypt/decrypt it.
 * Add new display-only fields here without touching the server.
 */
export interface ClientMetadata {
  currentContext?: {
    tokens: number;
    contextWindow: number;
  };
  /** Whether there are pending interactive prompts (permissions, questions, plan approvals, git commits) */
  hasPendingPrompt?: boolean;
  /** Kanban phase: backlog, planning, implementing, validating, complete */
  phase?: string;
  /** Arbitrary tags for categorization */
  tags?: string[];
  /** Draft input text (unsent message) for cross-device sync */
  draftInput?: string;
  /** Epoch ms when draftInput was last updated by the sending device */
  draftUpdatedAt?: number;
  /** Marker that the title was AI-chosen; prevents repeated rename attempts. */
  hasBeenNamed?: boolean;
}
