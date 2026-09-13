import { isRetainedSession, sessionActivityAt, SESSION_TRANSCRIPT_TTL_MS } from '@nimbalyst/collab-protocol';
/**
 * CollabV3 Sync Provider
 *
 * Provides real-time sync of AI sessions using the CollabV3 protocol.
 * Uses WebSocket connections to Durable Objects with DO SQLite storage.
 *
 * Authentication:
 * - Uses personal Stytch JWTs or personal node access tokens
 * - User ID is extracted from the credential's 'sub' claim
 * - Credential is sent via the WebSocket URL's token query parameter
 *
 * Key differences from Y.js sync (CollabV2):
 * - Simple append-only message protocol (no CRDTs)
 * - Cursor-based pagination instead of state vectors
 * - Per-message encryption instead of whole-doc encryption
 * - No tombstone bloat from deletions
 */

import type { AgentMessage } from '../ai/server/types';
import type { PersonalJwt, PersonalMemberId } from '../auth/jwtScopes';
import { shouldSyncMessageForSessionRoom, truncateContentForSync } from './syncContentTruncator';
import { appendSyncClientParams, redactSyncUrl } from './syncClientInfo';
import { decodeNodeAccessTokenClaims, isNodeAccessToken } from './nodeCredentialToken';
import { buildSyncedSessionIndexFields } from './sessionIndexEntryFields';
import { resolveIndexSortTimestamp } from './sessionSortTimestamp';
import {
  createIndexPublicationGate,
  createKeyedSerialQueue,
  createPublishSequencer,
  indexPatchSignature,
} from './indexPublication';
import {
  bootstrapIndexMirror,
  createIndexReplicationMirror,
  deltaSyncIndexMirror,
  type DecryptedIndexChange,
  type IndexPageRequestInput,
} from './indexReplicationClient';
import { deriveTrackerPersonalStateKey } from './trackerPersonalStateKey';
import { hasPublishableConfig } from './projectConfig';
import { IndexEntryDecryptionError } from './indexEntryDecryptionError';
import { createPersonalSyncWriteGate, type PersonalSyncWriteGateSnapshot } from './personalSyncWriteGate';
import type {
  SyncConfig,
  SyncStatus,
  SyncProvider,
  SessionChange,
  SyncedSessionMetadata,
  SessionIndexData,
  ProjectIndexEntry,
  ProjectConfig,
  DeviceInfo,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  VoiceToolRequest,
  VoiceToolResponse,
  EncryptedSettingsPayload,
  EncryptedReadReceiptPayload,
  EncryptedTrackerPersonalStatePayload,
  SyncedTrackerPersonalStateChange,
  SyncedSettings,
  SessionControlMessage,
  EncryptedAttachment,
  FileIndexData,
  MobilePushOptions,
  MobilePushResult,
  PushChangeOutcome,
} from './types';
import { filterSessionsForPersonalSync } from './types';
import type { FleetActivitySnapshot, PushRejectionCause } from '@nimbalyst/collab-protocol';
import type { SyncedReadReceipt } from '../readReceipts/readReceipts';

/**
 * `readyState` values, spelled out rather than read off the global
 * `WebSocket` constructor.
 *
 * These are fixed by the WHATWG spec, and every implementation a host might
 * inject through `SyncConfig.createWebSocket` uses the same numbers. Reading
 * them from the global would make a host with no global `WebSocket` throw
 * `ReferenceError` on the hot path even though it supplied its own socket.
 */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * How long to wait for the server's `mobilePushResult` before giving up. Older
 * servers never send one, so this is also the ceiling on a no-op await.
 */
const MOBILE_PUSH_ACK_TIMEOUT_MS = 10_000;

// ============================================================================
// CollabV3 Protocol Types (matches server)
// ============================================================================

interface EncryptedMessage {
  id: string;
  sequence: number;
  createdAt: number;
  source: 'user' | 'assistant' | 'tool' | 'system';
  direction: 'input' | 'output';
  encryptedContent: string;
  iv: string;
  metadata: {
    tool_name?: string;
    has_attachments?: boolean;
    content_length?: number;
  };
}

/** Encrypted queued prompt for wire protocol */
interface EncryptedQueuedPrompt {
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
interface WireEncryptedAttachment {
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
interface PlaintextQueuedPrompt {
  options?: import("./types").RemoteTurnOptions;
  id: string;
  prompt: string;
  timestamp: number;
  /** Decrypted image attachments from mobile */
  attachments?: EncryptedAttachment[];
}

interface SessionMetadata {
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

interface SessionIndexEntry {
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
type DecryptedSessionIndexEntry = Omit<SessionIndexEntry, 'title' | 'encryptedTitle' | 'titleIv' | 'encryptedProjectId' | 'projectIdIv' | 'encryptedQueuedPrompts' | 'encryptedClientMetadata' | 'clientMetadataIv' | 'messageCount'> & {
  title: string;  // Required after decryption
  projectId: string;  // Decrypted project ID
  /** Optional on the wire (omitted = "keep what you have"); always concrete here. */
  messageCount: number;
  queuedPrompts?: PlaintextQueuedPrompt[];  // Decrypted queued prompts
  currentContext?: { tokens: number; contextWindow: number };  // Decrypted from client metadata
  hasBeenNamed?: boolean;  // Decrypted from client metadata
};

/** Encrypted create session request for wire protocol */
interface EncryptedCreateSessionRequest {
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
interface EncryptedCreateSessionResponse {
  requestId: string;
  success: boolean;
  sessionId?: string;
  error?: string;
}

/** Encrypted worktree creation request for wire protocol */
interface EncryptedCreateWorktreeRequest {
  requestId: string;
  encryptedProjectId: string;
  projectIdIv: string;
  timestamp: number;
}

/** Encrypted worktree creation response for wire protocol */
interface EncryptedCreateWorktreeResponse {
  requestId: string;
  success: boolean;
  error?: string;
}

/** Encrypted voice-tool request for wire protocol (toolName/args carry project knowledge). */
interface EncryptedVoiceToolRequest {
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
interface EncryptedVoiceToolResponse {
  requestId: string;
  success: boolean;
  encryptedResult?: string;
  resultIv?: string;
  encryptedError?: string;
  errorIv?: string;
}

interface IndexClientMetadataPatch {
  sessionId: string;
  encryptedClientMetadata?: string;
  clientMetadataIv?: string;
  isExecuting?: boolean;
  lastReadAt?: number;
}

type ClientMessage =
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
interface IndexChangeWire {
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
interface PersonalStatePageResponseWire {
  type: 'personalStatePageResponse';
  requestId: string;
  entries: Array<
    | { type: 'readReceiptBroadcast'; receipt: EncryptedReadReceiptPayload; fromConnectionId?: string }
    | { type: 'trackerPersonalStateBroadcast'; state: EncryptedTrackerPersonalStatePayload; fromConnectionId?: string }
  >;
  nextPageToken?: string;
  complete: boolean;
}

interface IndexPageResponseWire {
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
class IndexProtocolUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexProtocolUnsupportedError';
  }
}

/** Encrypted file index entry for wire protocol */
interface EncryptedFileIndexEntry {
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
interface ServerProjectEntry {
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

type ServerMessage =
  | { type: 'indexSessionExpired'; sessionId: string; activityAt: number }
  | { type: 'syncResponse'; messages: EncryptedMessage[]; metadata: SessionMetadata | null; hasMore: boolean; cursor: string | null }
  | { type: 'messageBroadcast'; message: EncryptedMessage; fromConnectionId?: string }
  | { type: 'metadataBroadcast'; metadata: Partial<SessionMetadata>; fromConnectionId?: string }
  | { type: 'indexSyncResponse'; sessions: SessionIndexEntry[]; projects: ServerProjectEntry[] }
  | { type: 'indexBroadcast'; session: SessionIndexEntry; fromConnectionId?: string }
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

// ============================================================================
// JWT Utilities
// ============================================================================

interface JwtClaims {
  sub: string;
  /** Node access-token expiry in UNIX seconds; Stytch refresh is owned by getJwt. */
  exp?: number;
  /** Stytch B2B organization_id claim. Personal-scoped JWTs carry the personal orgId; team-scoped JWTs carry the team orgId. */
  organization_id?: string;
}

/**
 * Decode a JWT's payload claims. Does not verify the signature -- the server does that.
 * The JWT is a base64url encoded string in the format: header.payload.signature
 */
function decodeJwtClaims(jwt: PersonalJwt): JwtClaims {
  if (isNodeAccessToken(jwt)) {
    const { sub, org, exp } = decodeNodeAccessTokenClaims(jwt);
    return { sub, organization_id: org, exp };
  }
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    // Decode the payload (second part)
    const payload = parts[1];
    // Add padding if needed for base64 decoding
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(decoded);

    if (!parsed.sub) {
      throw new Error('JWT missing sub claim');
    }

    return { sub: parsed.sub, organization_id: parsed.organization_id };
  } catch (error) {
    console.error('[CollabV3] Failed to decode JWT:', error);
    throw new Error('Invalid JWT: cannot decode claims');
  }
}

// ============================================================================
// Base64 Utilities (handles large byte arrays)
// ============================================================================

/**
 * Convert Uint8Array to base64 string.
 * Uses chunked approach to avoid call stack size limits with large arrays.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // For small arrays, use simple approach
  if (bytes.length < 1024) {
    return btoa(String.fromCharCode(...bytes));
  }

  // For large arrays, chunk to avoid stack overflow
  const CHUNK_SIZE = 8192;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

/**
 * Convert base64 string to Uint8Array.
 * Returns a Uint8Array backed by an ArrayBuffer (not SharedArrayBuffer).
 */
function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================================
// Encryption Utilities
// ============================================================================

async function encrypt(
  content: string,
  key: CryptoKey
): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(content);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return {
    encrypted: uint8ArrayToBase64(new Uint8Array(encrypted)),
    iv: uint8ArrayToBase64(iv),
  };
}

async function decrypt(
  encrypted: string,
  iv: string,
  key: CryptoKey
): Promise<string> {
  const encryptedBytes = base64ToUint8Array(encrypted);
  const ivBytes = base64ToUint8Array(iv);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    encryptedBytes
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Hex SHA-256 of a string. Used to derive an opaque, id-hiding routing key for
 * read receipts (so the server can dedup per entity without learning the id).
 */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Metadata Encryption Helpers (for title and queued prompts)
// ============================================================================

/**
 * Encrypt queued prompts for wire transmission.
 * Each prompt's text is encrypted individually.
 */
async function encryptQueuedPrompts(
  prompts: PlaintextQueuedPrompt[],
  key: CryptoKey
): Promise<EncryptedQueuedPrompt[]> {
  return Promise.all(
    prompts.map(async (prompt) => {
      const { encrypted, iv } = await encrypt(prompt.prompt, key);
      return {
        id: prompt.id,
        encryptedPrompt: encrypted,
        iv,
        timestamp: prompt.timestamp,
        ...(prompt.attachments?.length ? { encryptedAttachments: prompt.attachments } : {}),
        ...(prompt.options ? {options: prompt.options} : {}),
      };
    })
  );
}

/**
 * Decrypt queued prompts received from wire.
 * Each prompt's text is decrypted individually.
 */
async function decryptQueuedPrompts(
  prompts: EncryptedQueuedPrompt[],
  key: CryptoKey
): Promise<PlaintextQueuedPrompt[]> {
  return Promise.all(
    prompts.map(async (prompt) => {
      const decryptedPrompt = await decrypt(prompt.encryptedPrompt, prompt.iv, key);
      const result: PlaintextQueuedPrompt = {
        id: prompt.id,
        prompt: decryptedPrompt,
        timestamp: prompt.timestamp,
      };
      if (prompt.options) result.options = prompt.options;
      // Pass through encrypted attachments (desktop decrypts them when processing)
      if (prompt.encryptedAttachments && prompt.encryptedAttachments.length > 0) {
        result.attachments = prompt.encryptedAttachments;
      }
      return result;
    })
  );
}

/**
 * Encrypt a session title for wire transmission.
 */
async function encryptTitle(
  title: string,
  key: CryptoKey
): Promise<{ encryptedTitle: string; titleIv: string }> {
  const { encrypted, iv } = await encrypt(title, key);
  return {
    encryptedTitle: encrypted,
    titleIv: iv,
  };
}

/**
 * Decrypt a session title received from wire.
 */
async function decryptTitle(
  encryptedTitle: string,
  titleIv: string,
  key: CryptoKey
): Promise<string> {
  return decrypt(encryptedTitle, titleIv, key);
}

/**
 * Client metadata that gets encrypted and synced opaquely through the server.
 * The server never reads this — only clients encrypt/decrypt it.
 * Add new display-only fields here without touching the server.
 */
interface ClientMetadata {
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

/**
 * Extract ClientMetadata from raw PGLite metadata.
 * This is the single place that maps database schema -> encrypted client metadata.
 */
function buildClientMetadataFromRaw(
  metadata?: Record<string, any>,
  options: { hasBeenNamed?: boolean } = {}
): ClientMetadata | undefined {
  const tokenUsage = metadata?.tokenUsage;
  const phase = metadata?.phase as string | undefined;
  const tags = metadata?.tags as string[] | undefined;
  const draftInput = metadata?.draftInput as string | undefined;
  const draftUpdatedAt = metadata?.draftUpdatedAt as number | undefined;
  const hasBeenNamed = options.hasBeenNamed;
  const hasTokenUsage = tokenUsage?.totalTokens && tokenUsage?.contextWindow;
  const hasPhaseOrTags = phase || (tags && tags.length > 0);
  // draftInput can be "" (explicit clear) - treat as meaningful
  const hasDraftField = draftInput !== undefined;
  const hasNamingMarker = hasBeenNamed !== undefined;

  if (!hasTokenUsage && !hasPhaseOrTags && !hasDraftField && !hasNamingMarker) return undefined;

  const result: ClientMetadata = {};
  if (hasTokenUsage) {
    result.currentContext = {
      tokens: tokenUsage.totalTokens,
      contextWindow: tokenUsage.contextWindow,
    };
  }
  if (phase) result.phase = phase;
  if (tags && tags.length > 0) result.tags = tags;
  if (hasDraftField) result.draftInput = draftInput;
  if (draftUpdatedAt) result.draftUpdatedAt = draftUpdatedAt;
  if (hasNamingMarker) result.hasBeenNamed = hasBeenNamed;
  return result;
}

// Why: the lightweight `indexClientMetadataPatch` wire message added in
// v0.63.0 (commit fe78de08f) is not understood by the Cloudflare collab
// server or the iOS client. Any field whose value drives cross-device UI
// (spinner, pending prompt, context usage, phase, tags, unread badges)
// MUST go through the full `indexUpdate` path that those receivers already
// handle. Only fields that have no cross-device UI consumer today are safe
// to ride the patch fast-path. Widening this set without first shipping
// `indexClientMetadataPatchBroadcast` on the server + iOS will silently
// break mobile again -- see CollabV3Sync.routing.test.ts.
const INDEX_CLIENT_METADATA_PATCH_SAFE_KEYS = new Set([
  'draftInput',
  'draftUpdatedAt',
  'hasBeenNamed',
  'updatedAt',
]);

function isIndexClientMetadataOnlyUpdate(metadata: Partial<SyncedSessionMetadata>): boolean {
  const keys = Object.keys(metadata);
  if (keys.length === 0) return false;
  return keys.every((key) => INDEX_CLIENT_METADATA_PATCH_SAFE_KEYS.has(key));
}

// Test-only re-export. The predicate is the load-bearing protection against
// the v0.63.0 mobile-spins-forever regression; the suite in
// `__tests__/CollabV3Sync.routing.test.ts` pins its classification.
export { isIndexClientMetadataOnlyUpdate as isIndexClientMetadataOnlyUpdateForTest };

function buildClientMetadataFromCacheEntry(entry: Pick<
  CachedSessionIndex,
  'currentContext' | 'hasPendingPrompt' | 'phase' | 'tags' | 'draftInput' | 'draftUpdatedAt' | 'hasBeenNamed'
>): ClientMetadata | undefined {
  if (
    !entry.currentContext &&
    entry.hasPendingPrompt === undefined &&
    !entry.phase &&
    !entry.tags &&
    entry.draftInput === undefined &&
    entry.hasBeenNamed === undefined
  ) {
    return undefined;
  }

  return {
    currentContext: entry.currentContext,
    hasPendingPrompt: entry.hasPendingPrompt,
    phase: entry.phase,
    tags: entry.tags,
    draftInput: entry.draftInput,
    draftUpdatedAt: entry.draftUpdatedAt,
    hasBeenNamed: entry.hasBeenNamed,
  };
}

/**
 * Signature of everything an `indexClientMetadataPatch` would actually put on
 * the wire for this entry. Computed from plaintext, before encryption: AES-GCM
 * uses a fresh nonce per call, so comparing ciphertext would report a change
 * every single time. See `indexPublication.ts`.
 */
function indexPatchSignatureForEntry(entry: CachedSessionIndex): string {
  return indexPatchSignature({
    isExecuting: entry.isExecuting,
    lastReadAt: entry.lastReadAt,
    clientMetadata: buildClientMetadataFromCacheEntry(entry) as Record<string, unknown> | undefined,
  });
}

/**
 * Encrypt client metadata for wire transmission.
 */
async function encryptClientMetadata(
  metadata: ClientMetadata,
  key: CryptoKey
): Promise<{ encryptedClientMetadata: string; clientMetadataIv: string }> {
  const { encrypted, iv } = await encrypt(JSON.stringify(metadata), key);
  return { encryptedClientMetadata: encrypted, clientMetadataIv: iv };
}

/**
 * Decrypt client metadata received from wire.
 */
async function decryptClientMetadata(
  encryptedClientMetadata: string,
  clientMetadataIv: string,
  key: CryptoKey
): Promise<ClientMetadata> {
  const json = await decrypt(encryptedClientMetadata, clientMetadataIv, key);
  return JSON.parse(json);
}

/**
 * Fixed IV for projectId encryption.
 * Using a fixed IV makes encryption deterministic so the same projectId always
 * produces the same ciphertext, allowing the server to deduplicate by encrypted value.
 * This is acceptable because project_ids are not secret (just privacy-sensitive)
 * and the encryption key itself provides the security.
 */
const PROJECT_ID_FIXED_IV = new Uint8Array([
  0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x5f, 0x69, 0x64, 0x5f, 0x69 // "project_id_i"
]);

/**
 * Encrypt a project ID for wire transmission.
 * Uses a fixed IV so the same projectId always produces the same ciphertext,
 * enabling server-side deduplication.
 */
async function encryptProjectId(
  projectId: string,
  key: CryptoKey
): Promise<{ encryptedProjectId: string; projectIdIv: string }> {
  const encoder = new TextEncoder();
  const data = encoder.encode(projectId);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: PROJECT_ID_FIXED_IV },
    key,
    data
  );

  return {
    encryptedProjectId: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    projectIdIv: btoa(String.fromCharCode(...PROJECT_ID_FIXED_IV)),
  };
}

/**
 * Decrypt a project ID received from wire.
 */
async function decryptProjectId(
  encryptedProjectId: string,
  projectIdIv: string,
  key: CryptoKey
): Promise<string> {
  return decrypt(encryptedProjectId, projectIdIv, key);
}

/**
 * Turn a wire `SessionIndexEntry` into the pair the client keeps: the decrypted
 * entry handed to callers of `fetchIndex`, and the cache row the rest of the
 * provider reads.
 *
 * ANY decryption failure throws `IndexEntryDecryptionError`, on every path. A
 * v2 page is the unit that advances the replication cursor, so silently
 * dropping a field -- or a whole row -- would mark coverage complete over data
 * we never read. The legacy full response and live broadcasts are held to the
 * same rule because the alternative was GitHub #1117: the legacy path used to
 * treat an unreadable row as something to delete from the server and republish
 * under this device's key, which wiped every other device's index. A row this
 * key cannot read is a key problem on this device, never server state to fix.
 *
 * Shared by all paths so they cannot drift in what they carry off the wire.
 */

/**
 * Contract check for one row of a v2 page, run BEFORE any decryption.
 *
 * Everything here fails the page rather than skipping the row. A page is the
 * unit that advances the replication cursor: a row we quietly ignore is a row
 * the cursor claims coverage over and the local side never saw. That includes
 * files, whose payload we treat as opaque -- opaque is not the same as
 * unvalidated, and the identity still has to line up.
 */
function assertValidIndexChange(change: IndexChangeWire): void {
  if (change.removalReason !== undefined && (!change.deleted || change.entity !== 'session'
    || !['expired', 'deleted'].includes(change.removalReason))) {
    throw new IndexEntryDecryptionError('Invalid session removal reason');
  }
  if (change.entity !== 'session' && change.entity !== 'project' && change.entity !== 'file') {
    throw new IndexEntryDecryptionError(`Unknown index entity '${String((change as { entity?: unknown }).entity)}' for ${String(change.id)}`);
  }
  if (typeof change.id !== 'string' || change.id.length === 0) {
    throw new IndexEntryDecryptionError(`Index change for ${change.entity} carried no id`);
  }
  if (!Number.isSafeInteger(change.revision) || change.revision < 0) {
    throw new IndexEntryDecryptionError(`Index change ${change.entity}:${change.id} carried an unusable revision: ${String(change.revision)}`);
  }
  if (typeof change.deleted !== 'boolean') {
    throw new IndexEntryDecryptionError(`Index change ${change.entity}:${change.id} carried a non-boolean deleted flag`);
  }

  const payloads = [change.session, change.project, change.file].filter((p) => p !== undefined);
  if (change.deleted) {
    // A tombstone with a payload is ambiguous: delete or upsert?
    if (payloads.length > 0) {
      throw new IndexEntryDecryptionError(`Tombstone ${change.entity}:${change.id} carried a payload`);
    }
    return;
  }
  if (payloads.length !== 1) {
    throw new IndexEntryDecryptionError(`Index change ${change.entity}:${change.id} carried ${payloads.length} payloads; expected exactly 1`);
  }

  // The payload has to be the one the entity names, and it has to describe the
  // same row the change id does -- otherwise the mirror would key a row by one
  // identity while holding another's data.
  if (change.entity === 'session') {
    if (!change.session) throw new IndexEntryDecryptionError(`Session change ${change.id} carried a non-session payload`);
    if (change.session.sessionId !== change.id) {
      throw new IndexEntryDecryptionError(`Session change ${change.id} carries payload for ${String(change.session.sessionId)}`);
    }
    return;
  }
  if (change.entity === 'project') {
    if (!change.project) throw new IndexEntryDecryptionError(`Project change ${change.id} carried a non-project payload`);
    // Project identity on the wire is the ENCRYPTED project id.
    if (change.project.encryptedProjectId !== change.id) {
      throw new IndexEntryDecryptionError(`Project change ${change.id} carries payload for a different encrypted project id`);
    }
    return;
  }
  if (!change.file) throw new IndexEntryDecryptionError(`File change ${change.id} carried a non-file payload`);
  if (change.file.docId !== change.id) {
    throw new IndexEntryDecryptionError(`File change ${change.id} carries payload for ${String(change.file.docId)}`);
  }
}

async function decryptSessionIndexEntry(
  entry: SessionIndexEntry,
  key: CryptoKey | undefined,
): Promise<{ decrypted: DecryptedSessionIndexEntry; cacheEntry: CachedSessionIndex }> {
  let projectId: string;
  if (entry.encryptedProjectId && entry.projectIdIv && key) {
    try {
      projectId = await decryptProjectId(entry.encryptedProjectId, entry.projectIdIv, key);
    } catch {
      throw new IndexEntryDecryptionError(`Cannot decrypt projectId for session ${entry.sessionId}`);
    }
  } else {
    projectId = 'unknown';
  }

  let title: string;
  if (entry.encryptedTitle && entry.titleIv && key) {
    try {
      title = await decryptTitle(entry.encryptedTitle, entry.titleIv, key);
    } catch {
      throw new IndexEntryDecryptionError(`Cannot decrypt title for session ${entry.sessionId}`);
    }
  } else {
    title = 'Untitled';
  }

  let queuedPrompts: Array<{ id: string; prompt: string; timestamp: number }> | undefined;
  if (entry.encryptedQueuedPrompts && entry.encryptedQueuedPrompts.length > 0 && key) {
    try {
      queuedPrompts = await decryptQueuedPrompts(entry.encryptedQueuedPrompts, key);
    } catch {
      throw new IndexEntryDecryptionError(`Cannot decrypt queued prompts for session ${entry.sessionId}`);
    }
  } else if (entry.queuedPromptCount === 0 || Array.isArray(entry.encryptedQueuedPrompts)) {
    queuedPrompts = [];
  }

  let currentContext: CachedSessionIndex['currentContext'];
  let hasPendingPrompt: boolean | undefined;
  let phase: string | undefined;
  let tags: string[] | undefined;
  let draftInput: string | undefined;
  let draftUpdatedAt: number | undefined;
  let hasBeenNamed: boolean | undefined;
  if (entry.encryptedClientMetadata && entry.clientMetadataIv && key) {
    try {
      const clientMeta = await decryptClientMetadata(entry.encryptedClientMetadata, entry.clientMetadataIv, key);
      currentContext = clientMeta.currentContext;
      hasPendingPrompt = clientMeta.hasPendingPrompt;
      phase = clientMeta.phase;
      tags = clientMeta.tags;
      // An empty string is a real value: it is how "clear draft" reaches the
      // renderer from another device.
      draftInput = clientMeta.draftInput;
      draftUpdatedAt = clientMeta.draftUpdatedAt;
      hasBeenNamed = clientMeta.hasBeenNamed;
    } catch {
      throw new IndexEntryDecryptionError(`Cannot decrypt client metadata for session ${entry.sessionId}`);
    }
  }

  const decrypted: DecryptedSessionIndexEntry = {
    sessionId: entry.sessionId,
    projectId,
    title,
    provider: entry.provider,
    model: entry.model,
    mode: entry.mode,
    sessionType: entry.sessionType,
    parentSessionId: entry.parentSessionId,
    worktreeId: entry.worktreeId,
    hostDeviceId: entry.hostDeviceId,
    agentRole: entry.agentRole,
    createdBySessionId: entry.createdBySessionId,
    isArchived: entry.isArchived,
    isPinned: entry.isPinned,
    branchedFromSessionId: entry.branchedFromSessionId,
    branchPointMessageId: entry.branchPointMessageId,
    branchedAt: entry.branchedAt,
    messageCount: entry.messageCount ?? 0,
    lastMessageAt: entry.lastMessageAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    pendingExecution: entry.pendingExecution,
    isExecuting: entry.isExecuting,
    queuedPromptCount: entry.queuedPromptCount,
    queuedPrompts,
    hasPendingPrompt: hasPendingPrompt ?? entry.hasPendingPrompt,
    currentContext,
    lastReadAt: entry.lastReadAt,
  };

  const cacheEntry: CachedSessionIndex = {
    ...decrypted,
    phase,
    tags,
    draftInput,
    draftUpdatedAt,
    hasBeenNamed,
  };

  return { decrypted, cacheEntry };
}

/** Decrypted project row, as returned to `fetchIndex` callers. */
interface DecryptedProjectIndexEntry {
  projectId: string;
  name: string;
  sessionCount: number;
  lastActivityAt: number;
  syncEnabled: boolean;
  gitRemoteHash?: string;
}

/**
 * Decrypt a wire `ProjectIndexEntry`. Throws `IndexEntryDecryptionError` when
 * the projectId was written under a different key; the name falls back to the
 * path tail when only the name fails, since the id alone still identifies the
 * project.
 */
async function decryptProjectIndexEntry(
  proj: ServerProjectEntry,
  key: CryptoKey | undefined,
): Promise<DecryptedProjectIndexEntry> {
  let projectId: string;
  if (proj.encryptedProjectId && proj.projectIdIv && key) {
    try {
      projectId = await decryptProjectId(proj.encryptedProjectId, proj.projectIdIv, key);
    } catch {
      throw new IndexEntryDecryptionError('Cannot decrypt projectId for a project index entry');
    }
  } else {
    projectId = 'unknown';
  }

  let name: string;
  if (proj.encryptedName && proj.nameIv && key) {
    try {
      name = await decryptProjectName(proj.encryptedName, proj.nameIv, key);
    } catch {
      name = projectId.split('/').pop() ?? 'Unknown';
    }
  } else {
    name = projectId.split('/').pop() ?? 'Unknown';
  }

  return {
    projectId,
    name,
    sessionCount: proj.sessionCount,
    lastActivityAt: proj.lastActivityAt,
    syncEnabled: proj.syncEnabled,
    gitRemoteHash: proj.gitRemoteHash,
  };
}

/** One fully decrypted legacy row: the fetch result and the cache row. */
type DecryptedLegacyIndexRow = { decrypted: DecryptedSessionIndexEntry; cacheEntry: CachedSessionIndex };

/**
 * Decrypt a legacy full-index response in its entirety before any of it is
 * committed. Rows are decrypted independently so the failure carries counts
 * instead of stopping at the first unreadable row, and there is deliberately
 * no per-row logging: the #1117 reporter saw hundreds of lines a minute.
 */
async function decodeLegacyIndexSnapshot(
  sessions: SessionIndexEntry[],
  projects: ServerProjectEntry[],
  key: CryptoKey | undefined,
): Promise<{ rows: DecryptedLegacyIndexRow[]; projects: DecryptedProjectIndexEntry[] }> {
  const unreadable = (err: unknown): null => {
    if (err instanceof IndexEntryDecryptionError) return null;
    throw err;
  };
  const rowResults = await Promise.all(sessions.map((entry) => decryptSessionIndexEntry(entry, key).catch(unreadable)));
  const projectResults = await Promise.all(projects.map((proj) => decryptProjectIndexEntry(proj, key).catch(unreadable)));

  const rows = rowResults.filter((row): row is DecryptedLegacyIndexRow => row !== null);
  const decryptedProjects = projectResults.filter((proj): proj is DecryptedProjectIndexEntry => proj !== null);
  const unreadableSessions = sessions.length - rows.length;
  const unreadableProjects = projects.length - decryptedProjects.length;
  if (unreadableSessions > 0 || unreadableProjects > 0) {
    throw new IndexEntryDecryptionError(
      `Legacy index snapshot cannot be decrypted with this device's sync key: ${unreadableSessions} of ${sessions.length} session rows and ${unreadableProjects} of ${projects.length} project rows were written under a different key`,
    );
  }
  return { rows, projects: decryptedProjects };
}

/**
 * Encrypt a project name for wire transmission.
 */
async function encryptProjectName(
  name: string,
  key: CryptoKey
): Promise<{ encryptedName: string; nameIv: string }> {
  const { encrypted, iv } = await encrypt(name, key);
  return {
    encryptedName: encrypted,
    nameIv: iv,
  };
}

/**
 * Decrypt a project name received from wire.
 */
async function decryptProjectName(
  encryptedName: string,
  nameIv: string,
  key: CryptoKey
): Promise<string> {
  return decrypt(encryptedName, nameIv, key);
}

/**
 * Encrypt a project path for wire transmission.
 */
async function encryptProjectPath(
  path: string,
  key: CryptoKey
): Promise<{ encryptedPath: string; pathIv: string }> {
  const { encrypted, iv } = await encrypt(path, key);
  return {
    encryptedPath: encrypted,
    pathIv: iv,
  };
}

/**
 * Decrypt a project path received from wire.
 */
async function decryptProjectPath(
  encryptedPath: string,
  pathIv: string,
  key: CryptoKey
): Promise<string> {
  return decrypt(encryptedPath, pathIv, key);
}

// ============================================================================
// Session Connection
// ============================================================================

interface SessionConnection {
  ws: WebSocket;
  status: SyncStatus;
  statusListeners: Set<(status: SyncStatus) => void>;
  changeListeners: Set<(change: SessionChange) => void>;
  lastSequence: number;
  encryptionKey?: CryptoKey;
  /** Cached metadata from syncResponse and metadataBroadcast */
  cachedMetadata?: Partial<SessionMetadata>;
  /** Timestamp of last activity (send/receive) for LRU eviction */
  lastActivity: number;
  /** A node socket retains its opening credential even after index rotation. */
  nodeCredentialExpiresAt?: number;
}

function sessionTransportUsable(session: SessionConnection | undefined): session is SessionConnection {
  return !!session?.status.connected && session.ws.readyState === WS_OPEN
    && (session.nodeCredentialExpiresAt === undefined || session.nodeCredentialExpiresAt > Date.now() + 30_000);
}

// Only a genuinely terminal room state disables a session's message sync. The
// row-count ceiling is terminal: nothing will ever be appendable again.
const FATAL_MESSAGE_SYNC_ERROR_CODES = new Set([
  'message_limit_exceeded',
]);

// Per-message rejections. One oversized message -- typically a screenshot that
// could not be shrunk enough -- must not take the rest of the session's
// transcript off mobile with it. The room may also have room for smaller
// messages even when it just refused a large one, so we keep going and let the
// message be retried on a later resync.
const SKIPPABLE_MESSAGE_SYNC_ERROR_CODES = new Set([
  'message_too_large',
  'storage_limit_exceeded',
]);

function isFatalMessageSyncErrorCode(code?: string): boolean {
  return code !== undefined && FATAL_MESSAGE_SYNC_ERROR_CODES.has(code);
}

function isSkippableMessageSyncErrorCode(code?: string): boolean {
  return code !== undefined && SKIPPABLE_MESSAGE_SYNC_ERROR_CODES.has(code);
}

export { isFatalMessageSyncErrorCode as isFatalMessageSyncErrorCodeForTest };
export { isSkippableMessageSyncErrorCode as isSkippableMessageSyncErrorCodeForTest };

// Cache of session index entries for partial update merging
// This cache stores DECRYPTED values locally
interface CachedSessionIndex {
  sessionId: string;
  projectId: string;
  /** Decrypted title (stored locally after decryption) */
  title: string;
  provider: string;
  model?: string;
  mode?: 'agent' | 'planning';
  /** Structural type: 'session' | 'workstream' | 'blitz' */
  sessionType?: string;
  /** Parent session ID for workstream/worktree hierarchy */
  parentSessionId?: string;
  /** Worktree ID for git worktree association */
  worktreeId?: string;
  /** Stable device ID of the host that owns this session. */
  hostDeviceId?: string;
  /** Agent role marker (e.g. 'meta-agent', 'standard'); drives mobile meta-agent grouping. */
  agentRole?: string;
  /** Meta-agent parent session ID for spawned children; drives mobile meta-agent grouping. */
  createdBySessionId?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  branchedFromSessionId?: string;
  branchPointMessageId?: number;
  branchedAt?: number;
  messageCount: number;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
  // Execution state fields synced via index updates to mobile
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  isExecuting?: boolean;
  /** Decrypted queued prompts (stored locally after decryption) */
  queuedPrompts?: PlaintextQueuedPrompt[];
  /** Durable queue size, including explicit zero when prompt payloads are omitted. */
  queuedPromptCount?: number;
  /** Current context usage (from /context command for Claude Code) */
  currentContext?: {
    tokens: number;
    contextWindow: number;
  };
  /** Whether there are pending interactive prompts (permissions or questions) waiting for response */
  hasPendingPrompt?: boolean;
  /** Kanban phase: backlog, planning, implementing, validating, complete */
  phase?: string;
  /** Arbitrary tags for categorization */
  tags?: string[];
  /** Unix timestamp ms when this session was last read by any device */
  lastReadAt?: number;
  /** Draft input text (unsent message) for cross-device sync */
  draftInput?: string;
  /** Epoch ms when draftInput was last updated by the sending device */
  draftUpdatedAt?: number;
  /** Marker that the title was AI-chosen; prevents repeated rename attempts. */
  hasBeenNamed?: boolean;
}

// ============================================================================
// CollabV3 Sync Provider
// ============================================================================

export function createCollabV3Sync(config: SyncConfig): SyncProvider {
  /**
   * This client's own device identity, read fresh on every call.
   *
   * `getDeviceInfo` exists so presence fields (focus, status, lastActiveAt)
   * reflect the moment they are read rather than the moment the provider was
   * constructed; `config.deviceInfo` is the static fallback for callers that
   * never supplied one. Every read of "who am I" goes through here — the
   * self-broadcast filters, device-targeted routing, and host attribution all
   * have to agree on the answer, and they had drifted into eight hand-copied
   * expressions of it.
   */
  const localDeviceInfo = (): DeviceInfo | undefined =>
    config.getDeviceInfo?.() ?? config.deviceInfo;
  const localDeviceId = (): string | undefined => localDeviceInfo()?.deviceId;

  /**
   * The single place this provider constructs a socket. Hosts without a usable
   * global `WebSocket` (or that need one proxied) pass `config.createWebSocket`.
   */
  const openWebSocket = (url: string): WebSocket =>
    config.createWebSocket ? config.createWebSocket(url) : new WebSocket(url);

  // We need to get the initial JWT synchronously for setup, but will refresh before each connection
  // The getJwt function is called before each WebSocket connection to ensure fresh JWT
  let currentJwt: PersonalJwt | null = null;
  let currentPersonalMemberId: PersonalMemberId | null = null;

  // Helper to get fresh JWT and extract user ID.
  // Uses config.personalMemberId as the authoritative room routing ID.
  // The JWT sub claim is validated against config.personalMemberId -- if they differ,
  // the JWT is from a different org (e.g., team) and the caller's getJwt()
  // should be returning a personal-org-scoped credential. Refuse mismatches
  // before connecting so desktop and mobile cannot route to different rooms.
  async function ensureFreshJwt(): Promise<{ jwt: PersonalJwt; personalMemberId: PersonalMemberId }> {
    const jwt = await config.getJwt();
    const claims = decodeJwtClaims(jwt);
    const jwtUserId = claims.sub;
    currentJwt = jwt;

    // Use config.personalMemberId from SyncManager as the canonical
    // room routing ID. This must match iOS which also uses the personal
    // member ID. If the JWT sub doesn't match, the server WILL reject the
    // WebSocket auth (it validates JWT sub === room URL userId) -- but
    // routing to the wrong room is worse because it silently breaks
    // cross-device sync (prompts, drafts, etc.).
    if (jwtUserId !== config.personalMemberId) {
      const jwtIsTeamScoped =
        !!claims.organization_id && !!config.orgId && claims.organization_id !== config.orgId;
      // Rate-limit: this used to log every 2s forever once the loop kicked in.
      const now = Date.now();
      if (now - lastJwtMismatchLogAt > JWT_MISMATCH_LOG_INTERVAL_MS) {
        lastJwtMismatchLogAt = now;
        console.warn(
          '[CollabV3] JWT sub does not match sync config personalMemberId -- refusing to connect (would be server-rejected and throttle the client).',
          {
            jwtSub: jwtUserId,
            jwtOrgId: claims.organization_id ?? null,
            configPersonalMemberId: config.personalMemberId,
            configOrgId: config.orgId,   // personalOrgId from SyncManager
            likelyCause: jwtIsTeamScoped
              ? 'JWT is team-scoped (organization_id differs from personal orgId). getJwt() should return a personal-org-scoped JWT -- check StytchAuthService.refreshPersonalSession / getPersonalSessionJwt.'
              : 'JWT and config disagree on the user ID. The persisted personalUserId is likely stale (e.g. saved as a team member ID before resolvePersonalUserId ran). Check StytchAuthService.resolvePersonalUserId and the persisted session-sync config.',
          },
        );
      }
      // Don't even attempt the connection -- the server will reject it and the
      // tight retry loop got us throttled in the past. Caller will set
      // `indexAuthBlocked` and stop scheduling reconnects.
      const err = new Error('CollabV3 JWT/personal-member mismatch -- connection refused locally to avoid server throttling');
      (err as any).code = 'AUTH_MISMATCH';
      throw err;
    }
    if (claims.exp !== undefined && Date.now() >= claims.exp * 1000) {
      throw new Error('CollabV3 node access token expired; getJwt must refresh it before connecting');
    }
    currentPersonalMemberId = config.personalMemberId;
    return { jwt, personalMemberId: currentPersonalMemberId };
  }

  function isAuthMismatchError(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as any).code === 'AUTH_MISMATCH';
  }

  // Get the personal member id synchronously after the JWT/config match is established.
  function getPersonalMemberId(): PersonalMemberId {
    if (currentPersonalMemberId) return currentPersonalMemberId;
    if (config.personalMemberId) return config.personalMemberId;
    throw new Error('JWT not initialized - call ensureFreshJwt first');
  }

  const sessions = new Map<string, SessionConnection>();
  const sessionConnectionsInFlight = new Map<string, Promise<void>>();
  const sessionStatusListeners = new Map<string, Set<(status: SyncStatus) => void>>();
  const sessionChangeListeners = new Map<string, Set<(change: SessionChange) => void>>();
  const sessionIndexCache = new Map<string, CachedSessionIndex>();
  /**
   * Connection-scoped record of what the server is believed to hold for each
   * session's patch-projected fields. Suppresses the per-message
   * `{ updatedAt }` burst, whose patch payload carries nothing the server does
   * not already have. Reset on every index disconnect. See
   * `indexPublication.ts`.
   */
  const indexPublicationGate = createIndexPublicationGate();
  /**
   * Whether this device may publish personal-sync ciphertext at all. Opens
   * only after a complete index read decrypts under this key; closes on any
   * row this key cannot read, or when the server refuses this client build.
   * See `personalSyncWriteGate.ts` and GitHub #1117.
   */
  const personalSyncWriteGate = createPersonalSyncWriteGate();
  const loggedWithheldWrites = new Set<string>();
  personalSyncWriteGate.onChange(() => loggedWithheldWrites.clear());
  /** True when a personal-sync write must be withheld. Logs once per kind per gate state. */
  function withholdPersonalSyncWrite(kind: string): boolean {
    if (personalSyncWriteGate.canWrite()) return false;
    const snapshot = personalSyncWriteGate.snapshot();
    if (!loggedWithheldWrites.has(kind)) {
      loggedWithheldWrites.add(kind);
      const why = snapshot.reason ? `${snapshot.state} (${snapshot.reason})` : snapshot.state;
      console.warn(`[CollabV3] Withholding ${kind}: personal-sync writes are ${why}.${snapshot.detail ? ` ${snapshot.detail}` : ''}`);
    }
    return true;
  }
  /** Serializes index publications per session so gate check + send stay atomic. */
  // Negative acknowledgments are versioned by content activity, never by UI
  // edits. Bound this connection-local optimization; the server still enforces TTL.
  const rejectedIndexActivity = new Map<string, number>();
  function wasIndexActivityRejected(id: string, activity: number | undefined): boolean {
    return activity !== undefined && rejectedIndexActivity.get(id) === activity;
  }

  const indexPublishQueue = createKeyedSerialQueue();
  /**
   * Guards the window between reading the cache and sending. The bulk
   * reconciliation path encrypts hundreds of entries outside the per-session
   * queue, so a live patch can overtake it; whichever build is stale by send
   * time drops its payload rather than overwriting the newer one.
   */
  const publishSequencer = createPublishSequencer();

  /** Sending is not acceptance: a server can refuse an expired publication. */
  function noteSessionRowPublished(sessionId: string): void {
    publishSequencer.bump(sessionId);
    // Only a versioned upsert received from the server retires its tombstone.
  }

  /**
   * True when a payload built before an `await` may still be published: same
   * socket, same connection generation, and no newer publication for this
   * session in the meantime.
   */
  function isPublishStillCurrent(
    sessionId: string,
    socket: WebSocket,
    generation: number,
    capturedSeq: number,
    what: string,
  ): boolean {
    if (generation !== indexConnectionGeneration || indexWs !== socket || !indexConnected) {
      // The socket we read at build time is gone. Publishing here would record
      // a gate signature for a server connection that never saw the payload.
      console.warn(`[CollabV3] Dropping ${what} for ${sessionId}: index connection changed during encryption`);
      return false;
    }
    if (publishSequencer.isStale(sessionId, capturedSeq)) {
      console.warn(`[CollabV3] Dropping ${what} for ${sessionId}: a newer publication landed first`);
      return false;
    }
    return true;
  }
  const disabledMessageSyncSessions = new Set<string>();
  /**
   * Session IDs the caller has explicitly asked us to keep connected. Populated
   * on `connect(sessionId)`, cleared on `disconnect(sessionId)`/`disconnectAll`.
   * After an index reconnect we re-subscribe to everything in this set so prompts
   * and outbound changes start flowing again without waiting for a user action.
   */
  const wantedSessions = new Set<string>();
  let indexWs: WebSocket | null = null;
  let indexConnected = false;
  /**
   * Index "ready" signal. Flips true once the index WebSocket is `open` AND
   * remains open past the stability window (see INDEX_STABILITY_MS). This is
   * what callers wait on when cascading reconnects -- `open` alone is not
   * enough because a stale network interface can produce an open-then-error
   * within a few ms.
   */
  let indexReady = false;
  let indexReadyListeners = new Set<() => void>();
  /**
   * Persistent subscribers to "the index socket is usable again".
   *
   * Distinct from `indexReadyListeners`, which is one-shot and cleared on every
   * fire because it backs `waitForIndexReady()`. These survive, because the
   * thing they exist for -- retrying work that could not be sent on the socket
   * that just went away -- has to happen on EVERY reconnect, not on the one the
   * caller happened to be awaiting.
   */
  const connectionGenerationListeners = new Set<(generation: number) => void>();
  const INDEX_STABILITY_MS = 500;
  let indexStabilityTimer: ReturnType<typeof setTimeout> | null = null;
  let deviceAnnounceInterval: ReturnType<typeof setInterval> | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let indexReconnectAttempts = 0;
  /**
   * Count of consecutive pre-open failures (WebSocket created but never reached
   * `onopen`). Distinct from `indexReconnectAttempts` so we can keep the first
   * few retries fast (handles legitimate "network just came up" races) while
   * still ramping into a real backoff if the failures keep coming. Without this,
   * a permanent server-side rejection (e.g. JWT/personal-member mismatch) used to hammer
   * the server at 2s forever and get us throttled.
   */
  let indexPreOpenFailures = 0;
  let indexReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * When `ensureFreshJwt` detects that the JWT cannot possibly succeed against
   * the configured room (JWT `sub` does not match `config.personalMemberId`), we set this
   * flag and stop scheduling reconnects entirely. The server would only reject
   * us anyway, and repeated rejections get the client IP throttled. Cleared by
   * an explicit `reconnectIndex()` (network change / user toggles sync / app
   * regains focus) so a refreshed JWT gets a chance to retry.
   */
  let indexAuthBlocked = false;
  /**
   * Rate-limit identical JWT-mismatch warnings. Without this we log the same
   * `[object Object]` warning every 2 seconds forever.
   */
  let lastJwtMismatchLogAt = 0;
  const JWT_MISMATCH_LOG_INTERVAL_MS = 60_000;

  function clearIndexReady(): void {
    indexReady = false;
    if (indexStabilityTimer) {
      clearTimeout(indexStabilityTimer);
      indexStabilityTimer = null;
    }
  }

  function markIndexReady(): void {
    if (indexReady) return;
    indexReady = true;
    // Snapshot listeners before calling -- resubscribe logic may add new ones.
    const listeners = Array.from(indexReadyListeners);
    indexReadyListeners.clear();
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        console.error('[CollabV3] indexReady listener threw:', err);
      }
    }

    // A usable socket under the current generation. Fired here rather than at
    // the disconnect that bumped the counter, because this is the moment at
    // which a caller retrying withheld work can actually succeed.
    for (const cb of Array.from(connectionGenerationListeners)) {
      try {
        cb(indexConnectionGeneration);
      } catch (err) {
        console.error('[CollabV3] connectionGeneration listener threw:', err);
      }
    }
  }

  function isMessageSyncDisabled(sessionId: string): boolean {
    return disabledMessageSyncSessions.has(sessionId);
  }

  function disableMessageSync(sessionId: string, code?: string, message?: string): void {
    const firstDisable = !disabledMessageSyncSessions.has(sessionId);
    disabledMessageSyncSessions.add(sessionId);
    if (firstDisable) {
      console.warn(
        `[CollabV3] Disabling message sync for ${sessionId} after fatal server rejection` +
        `${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`
      );
    }

    updateStatus(sessionId, {
      connected: false,
      syncing: false,
      error: message || 'Session reached the server sync limit',
    });
    wantedSessions.delete(sessionId);

    const session = sessions.get(sessionId);
    if (session) {
      sessions.delete(sessionId);
      try {
        session.ws.close();
      } catch {
        // The session is already disabled; socket cleanup is best-effort.
      }
    }
  }

  /**
   * After a successful index reconnect, re-subscribe any session rooms that
   * were previously connected. Without this, `sessions.delete(sessionId)` on
   * the session WS `onclose` would silently orphan per-session subscriptions
   * and the user would keep seeing `sessionExists: false` warnings.
   */
  function resubscribeWantedSessions(): void {
    if (wantedSessions.size === 0) return;
    for (const sessionId of wantedSessions) {
      if (sessions.has(sessionId)) continue;
      // Use the public `connect` method via the captured `provider` ref.
      // Fire-and-forget: individual session connect errors shouldn't block the cascade.
      provider.connect(sessionId).catch(err => {
        console.error(`[CollabV3] Failed to resubscribe session ${sessionId}:`, err);
      });
    }
  }

  /**
   * Schedule a reconnect attempt for the index WebSocket with exponential backoff.
   *
   * Backoff schedule:
   *   - mid-connection drops (server closed an open WS): exponential 2s, 4s, 8s,
   *     16s, 30s cap.
   *   - pre-open failures (WS never reached `onopen`): the first 3 attempts stay
   *     flat at 2s -- handles the legitimate "OS network just came up, DHCP
   *     still in progress" race. After that we ramp 5s, 10s, 30s, 60s, 120s,
   *     up to a 5-minute cap. Without this ramp a permanent server-side
   *     rejection (e.g. stale JWT) would hammer the server at 2s forever and
   *     get the client throttled.
   *
   * If `indexAuthBlocked` is set (JWT/personal-member mismatch detected), we don't
   * schedule a reconnect at all. Recovery happens only via an explicit
   * `reconnectIndex()` call (network change, user toggles sync, app focus).
   */
  function scheduleIndexReconnect(options?: { preOpenFailure?: boolean }): void {
    if (indexAuthBlocked) {
      // Don't keep hammering a connection the server will hard-reject. Wait for
      // an explicit reconnect trigger that resets indexAuthBlocked.
      return;
    }

    const preOpenFailure = options?.preOpenFailure ?? false;
    let delay: number;
    if (preOpenFailure) {
      indexPreOpenFailures++;
      if (indexPreOpenFailures <= 3) {
        delay = 2000; // fast retries for transient network-coming-up race
      } else {
        // Ramp: 5s, 10s, 30s, 60s, 120s, 300s cap.
        const ramp = [5_000, 10_000, 30_000, 60_000, 120_000, 300_000];
        const idx = Math.min(indexPreOpenFailures - 4, ramp.length - 1);
        delay = ramp[idx];
      }
    } else {
      delay = Math.min(2000 * Math.pow(2, indexReconnectAttempts), 30000);
      indexReconnectAttempts++;
    }
    console.log(`[CollabV3] Scheduling index reconnect attempt ${indexReconnectAttempts}${preOpenFailure ? ` (pre-open #${indexPreOpenFailures})` : ''} in ${delay}ms`);

    if (indexReconnectTimer) clearTimeout(indexReconnectTimer);
    indexReconnectTimer = setTimeout(() => {
      indexReconnectTimer = null;
      if (indexAuthBlocked) return;
      if (!indexWs && !indexConnected) {
        console.log('[CollabV3] Attempting to reconnect to index...');
        connectToIndex().catch(err => {
          if (isAuthMismatchError(err)) {
            // ensureFreshJwt already set indexAuthBlocked. Do not reschedule.
            console.warn('[CollabV3] Index reconnect blocked: JWT/personal-member mismatch. Waiting for explicit reconnect trigger.');
            return;
          }
          console.error('[CollabV3] Failed to reconnect to index:', err);
          // Schedule another attempt - connectToIndex() may have failed before
          // creating a WebSocket (e.g. JWT refresh failed), so onclose won't fire
          // and we'd never retry without this. Treat as pre-open failure since
          // the WS wasn't even created.
          scheduleIndexReconnect({ preOpenFailure: true });
        });
      }
    }, delay);
  }

  // Listeners for index changes (session updates broadcast to all connected clients)
  // Listeners receive decrypted data (CachedSessionIndex format)
  const indexChangeListeners = new Set<(sessionId: string, entry: CachedSessionIndex) => void>();

  // Listeners for session creation requests (from mobile)
  const createSessionRequestListeners = new Set<(request: CreateSessionRequest) => void>();

  // Listeners for session creation responses (for mobile to receive response from desktop)
  const createSessionResponseListeners = new Set<(response: CreateSessionResponse) => void>();

  // Listeners for worktree creation requests (from mobile)
  const createWorktreeRequestListeners = new Set<(request: CreateWorktreeRequest) => void>();

  // Listeners for voice-tool requests (from mobile; desktop runs the tool)
  const voiceToolRequestListeners = new Set<(request: VoiceToolRequest) => void>();

  // Listeners for voice-tool responses (for mobile to receive the desktop result)
  const voiceToolResponseListeners = new Set<(response: VoiceToolResponse) => void>();

  // Listeners for generic session control messages (cancel, question_response, etc.)
  const sessionControlMessageListeners = new Set<(message: SessionControlMessage) => void>();

  // Connected devices tracking
  const connectedDevices = new Map<string, DeviceInfo>();
  const deviceStatusListeners = new Set<(devices: DeviceInfo[]) => void>();

  // Settings sync listeners (for receiving synced settings from other devices)
  const settingsSyncListeners = new Set<(settings: SyncedSettings) => void>();

  // In-flight mobile push requests, keyed by requestId so concurrent requests
  // resolve to their own acknowledgements.
  const pendingMobilePushes = new Map<string, {
    resolve: (result: MobilePushResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Read-receipt listeners (unread-indicator state arriving from other devices)
  const readReceiptListeners = new Set<(receipt: SyncedReadReceipt) => void>();
  const trackerPersonalStateListeners = new Set<(change: SyncedTrackerPersonalStateChange) => void>();

  // Notify all device status listeners
  function notifyDeviceStatusChange(): void {
    const devices = Array.from(connectedDevices.values());
    // console.log('[CollabV3] notifyDeviceStatusChange:', devices.length, 'devices,', deviceStatusListeners.size, 'listeners');
    for (const listener of deviceStatusListeners) {
      try {
        listener(devices);
      } catch (err) {
        console.error('[CollabV3] Error in device status listener:', err);
      }
    }
  }

  // Queue for operations that need to wait for index connection
  type PendingOperation = { type: 'sessions'; data: SessionIndexData[]; options?: { syncMessages?: boolean; messageSyncRequests?: Array<{ sessionId: string; sinceTimestamp: number }>; getMessagesForSync?: (requests: Array<{ sessionId: string; sinceTimestamp: number }>) => Promise<Map<string, any[]>> } } | { type: 'projects'; data: ProjectIndexEntry[] };
  const pendingOperations: PendingOperation[] = [];

  // Queue for partial metadata updates waiting for the session to be cached
  // Key: sessionId, Value: partial metadata to merge when session is cached
  const pendingMetadataUpdates = new Map<string, Partial<SyncedSessionMetadata>>();

  async function attachQueuedPromptsToIndexEntry(
    indexEntry: SessionIndexEntry,
    queuedPrompts: PlaintextQueuedPrompt[] | undefined,
    queuedPromptCount: number | undefined
  ): Promise<void> {
    const resolvedCount = queuedPrompts?.length ?? queuedPromptCount;
    if (resolvedCount !== undefined) {
      indexEntry.queuedPromptCount = resolvedCount;
    }
    if (queuedPrompts === undefined) return;
    if (queuedPrompts.length === 0) {
      indexEntry.encryptedQueuedPrompts = [];
      return;
    }
    if (!config.encryptionKey) {
      throw new Error('[CollabV3] Cannot send queued prompts: no encryption key available');
    }
    indexEntry.encryptedQueuedPrompts = await encryptQueuedPrompts(queuedPrompts, config.encryptionKey);
  }

  function sendIndexUpdate(baseEntry: CachedSessionIndex): Promise<void> {
    return indexPublishQueue.run(baseEntry.sessionId, () => doSendIndexUpdate(baseEntry));
  }

  async function doSendIndexUpdate(baseEntry: CachedSessionIndex): Promise<void> {
    if (!isRetainedSession(sessionActivityAt(baseEntry)) || wasIndexActivityRejected(baseEntry.sessionId, sessionActivityAt(baseEntry))) return;
    if (!indexWs || !config.encryptionKey) {
      console.error('[CollabV3] Cannot send session update: index socket or encryption key missing');
      return;
    }
    if (withholdPersonalSyncWrite('index update')) return;
    // Capture the socket and connection generation BEFORE the encryption
    // awaits. `indexWs` is module state: by the time we come back it may be a
    // different socket (reconnect), and publishing this payload on it would
    // record a gate signature for a server that never saw it.
    const socket = indexWs;
    const generation = indexConnectionGeneration;
    const publishSeq = publishSequencer.read(baseEntry.sessionId);

    const { encryptedProjectId, projectIdIv } = await encryptProjectId(baseEntry.projectId, config.encryptionKey);

    const indexEntry: SessionIndexEntry = {
      sessionId: baseEntry.sessionId,
      encryptedProjectId,
      projectIdIv,
      provider: baseEntry.provider,
      model: baseEntry.model,
      mode: baseEntry.mode,
      sessionType: baseEntry.sessionType,
      parentSessionId: baseEntry.parentSessionId,
      worktreeId: baseEntry.worktreeId,
      hostDeviceId: baseEntry.hostDeviceId,
      agentRole: baseEntry.agentRole,
      createdBySessionId: baseEntry.createdBySessionId,
      isArchived: baseEntry.isArchived,
      isPinned: baseEntry.isPinned,
      messageCount: baseEntry.messageCount,
      lastMessageAt: baseEntry.lastMessageAt,
      createdAt: baseEntry.createdAt,
      updatedAt: baseEntry.updatedAt,
      pendingExecution: baseEntry.pendingExecution,
      isExecuting: baseEntry.isExecuting,
      lastReadAt: baseEntry.lastReadAt,
    };

    if (baseEntry.title) {
      const { encryptedTitle, titleIv } = await encryptTitle(baseEntry.title, config.encryptionKey);
      indexEntry.encryptedTitle = encryptedTitle;
      indexEntry.titleIv = titleIv;
    }

    await attachQueuedPromptsToIndexEntry(
      indexEntry,
      baseEntry.queuedPrompts,
      baseEntry.queuedPromptCount,
    );

    const clientMeta = buildClientMetadataFromCacheEntry(baseEntry);
    if (clientMeta) {
      const { encryptedClientMetadata, clientMetadataIv } = await encryptClientMetadata(clientMeta, config.encryptionKey);
      indexEntry.encryptedClientMetadata = encryptedClientMetadata;
      indexEntry.clientMetadataIv = clientMetadataIv;
    }

    if (!isPublishStillCurrent(baseEntry.sessionId, socket, generation, publishSeq, 'index update')) return;

    const publishedEntry: CachedSessionIndex = {
      ...baseEntry,
      queuedPromptCount: baseEntry.queuedPrompts?.length ?? baseEntry.queuedPromptCount,
    };
    sessionIndexCache.set(baseEntry.sessionId, publishedEntry);
    const indexMsg: ClientMessage = { type: 'indexUpdate', session: indexEntry };
    socket.send(JSON.stringify(indexMsg));
    // A full indexUpdate carries a superset of the patch projection, so the
    // server now holds these values and a following timestamp-only patch has
    // nothing to add. Recorded only after the send actually succeeded.
    indexPublicationGate.recordPublished(baseEntry.sessionId, indexPatchSignatureForEntry(publishedEntry));
    noteSessionRowPublished(baseEntry.sessionId);
  }

  function sendIndexClientMetadataPatch(baseEntry: CachedSessionIndex): Promise<void> {
    return indexPublishQueue.run(baseEntry.sessionId, () => doSendIndexClientMetadataPatch(baseEntry));
  }

  async function doSendIndexClientMetadataPatch(baseEntry: CachedSessionIndex): Promise<void> {
    if (!isRetainedSession(sessionActivityAt(baseEntry)) || wasIndexActivityRejected(baseEntry.sessionId, sessionActivityAt(baseEntry))) return;
    if (!indexWs || !config.encryptionKey) {
      console.error('[CollabV3] Cannot send index metadata patch: index socket or encryption key missing');
      return;
    }
    if (withholdPersonalSyncWrite('index metadata patch')) return;
    // See doSendIndexUpdate: socket and generation are captured before the
    // encryption await so a reconnect cannot be published onto.
    const socket = indexWs;
    const generation = indexConnectionGeneration;
    const publishSeq = publishSequencer.read(baseEntry.sessionId);

    // The patch wire message carries no `updatedAt`. Caching the caller's newer
    // local timestamp anyway would tell the next bulk publish that the server
    // already has it, and `resolveIndexSortTimestamp`'s mid-turn hold would leak
    // the drifted value onto the phone -- reordering the list mid-turn, which is
    // exactly what the hold exists to prevent. Keep the last value we actually
    // published; `lastMessageAt` still advances so unread state stays live.
    const previous = sessionIndexCache.get(baseEntry.sessionId);
    const publishedEntry: CachedSessionIndex = {
      ...baseEntry,
      updatedAt: previous?.updatedAt ?? baseEntry.updatedAt,
    };

    // Compare the projected plaintext before encrypting: a per-message
    // `{ updatedAt }` push projects to exactly what the server already holds,
    // and every such packet costs an IndexRoom write plus an iOS list re-sort.
    const signature = indexPatchSignatureForEntry(publishedEntry);
    const shouldSend = indexPublicationGate.shouldPublish(baseEntry.sessionId, signature);

    const patch: IndexClientMetadataPatch = {
      sessionId: baseEntry.sessionId,
      isExecuting: publishedEntry.isExecuting,
      lastReadAt: publishedEntry.lastReadAt,
    };

    const clientMeta = shouldSend ? buildClientMetadataFromCacheEntry(publishedEntry) : undefined;
    if (clientMeta) {
      const { encryptedClientMetadata, clientMetadataIv } = await encryptClientMetadata(clientMeta, config.encryptionKey);
      patch.encryptedClientMetadata = encryptedClientMetadata;
      patch.clientMetadataIv = clientMetadataIv;
    }

    if (!isPublishStillCurrent(baseEntry.sessionId, socket, generation, publishSeq, 'metadata patch')) return;
    sessionIndexCache.set(baseEntry.sessionId, publishedEntry);
    if (!shouldSend) return;

    const patchMsg: ClientMessage = { type: 'indexClientMetadataPatch', patch };
    try {
      socket.send(JSON.stringify(patchMsg));
    } catch (err) {
      // Nothing reached the server, so the gate must not remember this
      // projection or the retry would be suppressed as a no-op. Reconciliation
      // (or the next real change) re-publishes it.
      indexPublicationGate.invalidate(baseEntry.sessionId);
      console.error('[CollabV3] Failed to send index metadata patch:', err);
      return;
    }
    indexPublicationGate.recordPublished(baseEntry.sessionId, signature);
    publishSequencer.bump(baseEntry.sessionId);
  }

  /**
   * Apply any pending metadata updates for a session that was just cached.
   * This handles the case where isExecuting is pushed before the session is in the cache.
   */
  async function applyPendingMetadataUpdates(sessionId: string): Promise<void> {
    const pending = pendingMetadataUpdates.get(sessionId);
    if (!pending) return;

    pendingMetadataUpdates.delete(sessionId);

    const cached = sessionIndexCache.get(sessionId);
    if (!cached || !indexWs || !indexConnected) return;

    // console.log('[CollabV3] Applying pending metadata update for session:', sessionId, pending);

    // Merge pending update with cached entry
    // NOTE: Preserve cached.updatedAt -- pending metadata updates (isExecuting, context, etc.)
    // should not bump the sort timestamp. Only message appends change updatedAt.
    const updatedCache: CachedSessionIndex = {
      sessionId: sessionId,
      projectId: cached.projectId,
      title: pending.title ?? cached.title,
      provider: cached.provider,
      model: cached.model,
      mode: cached.mode,
      sessionType: 'sessionType' in pending ? pending.sessionType : cached.sessionType,
      parentSessionId: 'parentSessionId' in pending ? pending.parentSessionId : cached.parentSessionId,
      worktreeId: 'worktreeId' in pending ? pending.worktreeId : cached.worktreeId,
      hostDeviceId: 'hostDeviceId' in pending ? pending.hostDeviceId : cached.hostDeviceId,
      agentRole: cached.agentRole,
      createdBySessionId: cached.createdBySessionId,
      isArchived: 'isArchived' in pending ? pending.isArchived : cached.isArchived,
      isPinned: 'isPinned' in pending ? pending.isPinned : cached.isPinned,
      messageCount: cached.messageCount,
      lastMessageAt: cached.lastMessageAt,
      createdAt: cached.createdAt,
      updatedAt: pending.updatedAt ?? cached.updatedAt,
      pendingExecution: 'pendingExecution' in pending ? pending.pendingExecution : cached.pendingExecution,
      isExecuting: 'isExecuting' in pending ? pending.isExecuting : cached.isExecuting,
      queuedPrompts: 'queuedPrompts' in pending ? pending.queuedPrompts : cached.queuedPrompts,
      queuedPromptCount: 'queuedPrompts' in pending
        ? pending.queuedPrompts?.length ?? 0
        : cached.queuedPromptCount,
      currentContext: 'currentContext' in pending ? pending.currentContext : cached.currentContext,
      hasPendingPrompt: 'hasPendingPrompt' in pending ? pending.hasPendingPrompt : cached.hasPendingPrompt,
      phase: 'phase' in pending ? (pending as any).phase : cached.phase,
      tags: 'tags' in pending ? (pending as any).tags : cached.tags,
      lastReadAt: 'lastReadAt' in pending ? (pending as any).lastReadAt : cached.lastReadAt,
      draftInput: 'draftInput' in pending ? (pending as any).draftInput : cached.draftInput,
      draftUpdatedAt: 'draftUpdatedAt' in pending ? (pending as any).draftUpdatedAt : cached.draftUpdatedAt,
      hasBeenNamed: 'hasBeenNamed' in pending ? (pending as any).hasBeenNamed : cached.hasBeenNamed,
    };

    if (isIndexClientMetadataOnlyUpdate(pending)) {
      await sendIndexClientMetadataPatch(updatedCache);
    } else {
      await sendIndexUpdate(updatedCache);
    }
  }

  // Pending fetch index request (resolves when index_sync_response is received)
  let pendingIndexFetch: {
    resolve: (result: { complete?: boolean; indexProtocolVersion?: 1 | 2; deletedSessionIds?: string[]; sessions: DecryptedSessionIndexEntry[]; projects: Array<{ projectId: string; name: string; sessionCount: number; lastActivityAt: number; syncEnabled: boolean }> }) => void;
    reject: (error: Error) => void;
  } | null = null;

  // ==========================================================================
  // Versioned (v2) index replication -- bootstrap pages, then a delta cursor
  // ==========================================================================

  /**
   * Whether this server speaks `indexPageRequest`. Latched per index
   * connection: an old server answers `unknown_message_type`, and only that
   * explicit rejection falls back to the legacy full-index request, which
   * behaves exactly as it always did -- the fallback restores old behavior, it
   * does not make the legacy path bounded. A timeout is a failure, not a
   * downgrade; see the probe below.
   */
  let indexProtocolCapability: 'unknown' | 'v2' | 'legacy' = 'unknown';
  const indexMirror = createIndexReplicationMirror<
    DecryptedSessionIndexEntry,
    DecryptedProjectIndexEntry,
    EncryptedFileIndexEntry
  >();
  /** Account the mirror was filled for. A different personal member invalidates it. */
  let indexMirrorMemberId: PersonalMemberId | undefined;
  /** Bumped on every index disconnect so a late page response is dropped. */
  let indexConnectionGeneration = 0;
  let pendingIndexPage: {
    requestId: string;
    generation: number;
    mode: IndexPageRequestInput['mode'];
    resolve: (response: IndexPageResponseWire) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Serializes drains so a hint-driven poll and a fetchIndex never interleave pages. */
  const indexDrainQueue = createKeyedSerialQueue();
  const INDEX_PAGE_TIMEOUT_MS = 30_000;
  /**
   * Shorter deadline for the first request on a connection. Capability is
   * decided by the server's answer, not by this timer -- it only keeps a dead
   * connection from holding up the first reconciliation for the full 30s.
   */
  const INDEX_V2_PROBE_TIMEOUT_MS = 5_000;

  /**
   * Highest revision the server has hinted at, across every hint on this
   * connection. A hint that lands while the mirror is still being built (for
   * instance between the terminal bootstrap page arriving and its rows being
   * decrypted and applied) would otherwise be dropped and never replayed until
   * some unrelated mutation produced another hint.
   */
  let maxHintedRevision: number | undefined;
  /** One pending catch-up drain at a time; repeated hints coalesce into it. */
  let hintDrainScheduled = false;

  /** Connection generation whose personal-state replay has completed. */
  let personalStateReplayGeneration: number | undefined;
  let pendingPersonalStatePage: {
    requestId: string;
    generation: number;
    resolve: (response: PersonalStatePageResponseWire) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  function sendPersonalStatePageRequest(input: { pageToken?: string; limit?: number }): Promise<PersonalStatePageResponseWire> {
    if (!indexWs || !indexConnected) {
      return Promise.reject(new Error('[CollabV3] Index connection not available for personal state page'));
    }
    if (pendingPersonalStatePage) {
      return Promise.reject(new Error('[CollabV3] A personal state page request is already in flight'));
    }
    const requestId = newIndexRequestId();
    const generation = indexConnectionGeneration;
    return new Promise<PersonalStatePageResponseWire>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingPersonalStatePage?.requestId !== requestId) return;
        pendingPersonalStatePage = null;
        reject(new Error('[CollabV3] Timed out waiting for personalStatePageResponse'));
      }, INDEX_PAGE_TIMEOUT_MS);
      pendingPersonalStatePage = { requestId, generation, resolve, reject, timer };
      const msg: ClientMessage = { type: 'personalStatePageRequest', requestId, ...input };
      try {
        indexWs!.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        pendingPersonalStatePage = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function cancelPendingPersonalStatePage(reason: string): void {
    if (!pendingPersonalStatePage) return;
    const pending = pendingPersonalStatePage;
    pendingPersonalStatePage = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(`[CollabV3] ${reason}`));
  }

  function newIndexRequestId(): string {
    return typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `idx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function cancelPendingIndexPage(reason: string): void {
    if (!pendingIndexPage) return;
    const pending = pendingIndexPage;
    pendingIndexPage = null;
    clearTimeout(pending.timer);
    pending.reject(new Error(`[CollabV3] ${reason}`));
  }

  function sendIndexPageRequest(input: IndexPageRequestInput): Promise<IndexPageResponseWire> {
    if (!indexWs || !indexConnected) {
      return Promise.reject(new Error('[CollabV3] Index connection not available for page request'));
    }
    if (pendingIndexPage) {
      return Promise.reject(new Error('[CollabV3] An index page request is already in flight'));
    }
    const requestId = newIndexRequestId();
    const generation = indexConnectionGeneration;
    const timeoutMs = indexProtocolCapability === 'unknown'
      ? INDEX_V2_PROBE_TIMEOUT_MS
      : INDEX_PAGE_TIMEOUT_MS;

    return new Promise<IndexPageResponseWire>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingIndexPage?.requestId !== requestId) return;
        pendingIndexPage = null;
        // A timeout is a failure, never evidence that the server lacks v2. A
        // server that does not understand the frame says so with
        // `unknown_message_type`; falling back on silence would quietly
        // downgrade a v2 server that was merely slow or unreachable.
        reject(new Error('[CollabV3] Timed out waiting for indexPageResponse'));
      }, timeoutMs);

      pendingIndexPage = { requestId, generation, mode: input.mode, resolve, reject, timer };
      const msg: ClientMessage = { type: 'indexPageRequest', protocolVersion: 2, requestId, ...input };
      try {
        indexWs!.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        pendingIndexPage = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * The count to put on the wire for a bulk-published session, or `undefined`
   * to leave the server's stored count alone.
   *
   * `messageCountKnown === false` means the local query deliberately did not
   * count (see `getAllSessionsForSync`). On v2 that means: send nothing. On a
   * legacy server, which overwrites whatever it is given, the least-wrong value
   * is the count the server last reported to us.
   */
  function resolvePublishedMessageCount(
    session: SessionIndexData,
    existingCache: CachedSessionIndex | undefined,
  ): number | undefined {
    if (session.messageCountKnown !== false) return session.messageCount;
    if (indexProtocolCapability === 'v2') return undefined;
    return existingCache?.messageCount;
  }

  type PreparedIndexChange = DecryptedIndexChange<
    DecryptedSessionIndexEntry,
    DecryptedProjectIndexEntry,
    EncryptedFileIndexEntry
  >;

  /**
   * Decrypts a page's rows without touching local state. Cache rows are stashed
   * per `${id}:${revision}` so only the changes the mirror actually accepts get
   * applied locally -- a stale page must not overwrite the live cache.
   */
  function createIndexPageApplier(options: { generation: number; notifyListeners: boolean }) {
    // Per-page, cleared on every prepare: a long bootstrap must not accumulate
    // every decrypted row before anything is applied.
    let cacheEntries = new Map<string, CachedSessionIndex>();

    const assertSameConnection = (what: string) => {
      // Checked around the decrypt AND the apply, not just around the network
      // round trip: both are async, and a reconnect during either means this
      // page belongs to a connection whose cursor no longer applies.
      if (options.generation !== indexConnectionGeneration) {
        throw new Error(`[CollabV3] Index connection changed during ${what}; abandoning this drain`);
      }
    };

    return {
      prepare: async (entries: IndexChangeWire[]): Promise<PreparedIndexChange[]> => {
        assertSameConnection('page decryption');
        cacheEntries = new Map<string, CachedSessionIndex>();
        const changes: PreparedIndexChange[] = [];
        for (const change of entries) {
          // Contract first, decryption second: nothing here is skipped, because
          // the page's cursor would claim coverage over whatever we skipped.
          assertValidIndexChange(change);
          const base = {
            entity: change.entity,
            id: change.id,
            revision: change.revision,
            deleted: change.deleted,
            removalReason: change.removalReason,
          };
          if (change.deleted) {
            changes.push(base);
            continue;
          }
          if (change.entity === 'session') {
            // strict: a row we cannot fully read must fail the page rather than
            // be skipped. The mirror, the cursor and the local cache are all
            // left alone; the fetch reports failure and the caller skips
            // reconciliation for this cycle.
            const row = await decryptSessionIndexEntry(change.session!, config.encryptionKey);
            cacheEntries.set(`${change.id}:${change.revision}`, row.cacheEntry);
            changes.push({ ...base, session: row.decrypted });
          } else if (change.entity === 'project') {
            const project = await decryptProjectIndexEntry(change.project!, config.encryptionKey);
            changes.push({ ...base, project });
          } else {
            // File payloads stay opaque to this client (document sync owns the
            // file UI), but they are carried in the same stream under the same
            // cursor, so their identity is validated like everything else.
            changes.push({ ...base, file: change.file });
          }
        }
        assertSameConnection('page decryption');
        return changes;
      },
      commitPage: async (applied: PreparedIndexChange[]): Promise<void> => {
        assertSameConnection('page application');
        applyIndexChangesLocally(applied, cacheEntries, { notifyListeners: options.notifyListeners });
        cacheEntries = new Map<string, CachedSessionIndex>();
      },
    };
  }

  /**
   * Mirror the accepted session changes into the local cache. `notifyListeners`
   * is on for live (delta) drains only: under v2 the server sends a bare
   * `indexChangesAvailable` hint instead of `indexBroadcast`, so this is where
   * the existing index-change callbacks now come from. A cold bootstrap stays
   * silent rather than replaying thousands of rows through the UI.
   */
  function applyIndexChangesLocally(
    applied: PreparedIndexChange[],
    cacheEntries: Map<string, CachedSessionIndex>,
    options: { notifyListeners: boolean },
  ): void {
    for (const change of applied) {
      if (change.entity !== 'session') continue;
      if (change.deleted) {
        sessionIndexCache.delete(change.id);
        indexPublicationGate.invalidate(change.id);
        continue;
      }
      const cacheEntry = cacheEntries.get(`${change.id}:${change.revision}`);
      if (!cacheEntry) continue;
      sessionIndexCache.set(change.id, cacheEntry);
      indexPublicationGate.recordPublished(change.id, indexPatchSignatureForEntry(cacheEntry));
      if (!options.notifyListeners) continue;

      applyPendingMetadataUpdates(change.id).catch(err => {
        console.error('[CollabV3] Error applying pending metadata updates:', err);
      });
      indexChangeListeners.forEach((callback) => {
        try {
          callback(change.id, cacheEntry);
        } catch (err) {
          console.error('[CollabV3] Error in index change listener:', err);
        }
      });
    }
  }

  /**
   * A read receipt from another device -- live, or replayed on connect. Personal
   * single-user channel: decrypt and hand to the listeners, which merge
   * advance-only into local state.
   */
  async function handleReadReceiptBroadcast(payload: EncryptedReadReceiptPayload): Promise<void> {
    const ourDeviceId = localDeviceId();
    if (ourDeviceId && payload.deviceId === ourDeviceId) return;
    if (!config.encryptionKey) {
      console.error('[CollabV3] Cannot decrypt read receipt - no encryption key');
      return;
    }
    try {
      const json = await decrypt(payload.encryptedReceipt, payload.receiptIv, config.encryptionKey);
      const receipt: SyncedReadReceipt = JSON.parse(json);
      readReceiptListeners.forEach((callback) => {
        try {
          callback(receipt);
        } catch (err) {
          console.error('[CollabV3] Error in read receipt listener:', err);
        }
      });
    } catch (err) {
      console.error('[CollabV3] Failed to decrypt read receipt:', err);
    }
  }

  async function handleTrackerPersonalStateBroadcast(payload: EncryptedTrackerPersonalStatePayload): Promise<void> {
    const ourDeviceId = localDeviceId();
    if (ourDeviceId && payload.deviceId === ourDeviceId) return;
    if (!config.encryptionKey) {
      console.error('[CollabV3] Cannot decrypt tracker personal state - no encryption key');
      return;
    }
    try {
      const json = await decrypt(payload.encryptedState, payload.stateIv, config.encryptionKey);
      const change: SyncedTrackerPersonalStateChange = JSON.parse(json);
      trackerPersonalStateListeners.forEach((callback) => {
        try { callback(change); }
        catch (err) { console.error('[CollabV3] Error in tracker personal state listener:', err); }
      });
    } catch (err) {
      console.error('[CollabV3] Failed to decrypt tracker personal state:', err);
    }
  }

  /**
   * Replay read receipts and tracker personal state once per v2 connection.
   *
   * The legacy `indexSyncRequest` made the server replay both streams as
   * ordinary per-row broadcasts. v2 does not, so without this a v2 client would
   * silently lose cross-device read state and tracker personal state on every
   * reconnect. These pages are their own bounded stream: they carry no
   * revisions and never touch the index cursor or coverage.
   */
  async function replayPersonalState(): Promise<void> {
    if (personalStateReplayGeneration === indexConnectionGeneration) return;
    const generation = indexConnectionGeneration;
    let pageToken: string | undefined;
    let pages = 0;

    while (pages < 1_000) {
      const response = await sendPersonalStatePageRequest({ pageToken });
      pages++;
      if (generation !== indexConnectionGeneration) return;

      for (const entry of response.entries) {
        if (entry.type === 'readReceiptBroadcast') {
          await handleReadReceiptBroadcast(entry.receipt);
        } else {
          await handleTrackerPersonalStateBroadcast(entry.state);
        }
      }

      if (response.complete) {
        // Only a completed replay counts, so an interrupted one is retried on
        // the next drain instead of leaving a half-applied gap forever.
        personalStateReplayGeneration = generation;
        return;
      }
      if (!response.nextPageToken) {
        console.warn('[CollabV3] Personal state replay ended without completing; will retry');
        return;
      }
      pageToken = response.nextPageToken;
    }
    console.warn('[CollabV3] Personal state replay exceeded its page budget; will retry');
  }

  /**
   * Bring the mirror up to date: a delta from the committed cursor when we
   * already have coverage, otherwise a full bootstrap. A server-side cursor
   * reset drops coverage and re-bootstraps; it never means rows were deleted.
   */
  async function runIndexReplication(options: { notifyListeners: boolean }): Promise<void> {
    const memberId = currentPersonalMemberId ?? config.personalMemberId;
    if (indexMirrorMemberId !== undefined && memberId !== undefined && indexMirrorMemberId !== memberId) {
      // Account switch: the previous account's rows, revisions and cursor are
      // meaningless here and must not leak into this account's snapshot.
      indexMirror.reset();
    }
    indexMirrorMemberId = memberId;

    const generation = indexConnectionGeneration;

    if (indexMirror.isComplete() && indexMirror.cursor !== undefined) {
      const applier = createIndexPageApplier({ generation, notifyListeners: options.notifyListeners });
      const delta = await deltaSyncIndexMirror({
        mirror: indexMirror,
        request: sendIndexPageRequest,
        prepare: applier.prepare,
        commitPage: applier.commitPage,
      });
      if (!delta.resetRequired) return;
      console.warn('[CollabV3] Index cursor expired on the server; re-bootstrapping the mirror (absent rows are NOT deletions)');
    }

    // A cold bootstrap does not notify: replaying thousands of rows through the
    // UI is not a live update.
    const bootApplier = createIndexPageApplier({ generation, notifyListeners: false });
    await bootstrapIndexMirror({
      mirror: indexMirror,
      request: sendIndexPageRequest,
      prepare: bootApplier.prepare,
      commitPage: bootApplier.commitPage,
    });
  }

  /**
   * Run a catch-up drain if the server has hinted at a revision we have not
   * reached. Coalesces: repeated hints collapse into the one pending drain
   * rather than queueing a drain per hint. Called again after every completed
   * replication, which is what closes the race where a hint arrives while the
   * mirror is mid-bootstrap and therefore cannot be delta-synced yet.
   */
  function scheduleHintedDrain(): void {
    if (indexProtocolCapability === 'legacy') return;
    if (hintDrainScheduled) return;
    if (maxHintedRevision === undefined) return;
    // No coverage yet: a bootstrap is running or is about to. It calls back
    // here when it finishes, and the hint is still recorded.
    if (!indexMirror.isComplete() || indexMirror.cursor === undefined) return;
    if (indexMirror.cursor >= maxHintedRevision) return;

    hintDrainScheduled = true;
    void indexDrainQueue
      .run('index', () => {
        // Cleared as the drain starts, so a hint arriving mid-drain schedules
        // one follow-up instead of being swallowed.
        hintDrainScheduled = false;
        return runIndexReplicationWithPersonalState({ notifyListeners: true });
      })
      .catch(err => {
        hintDrainScheduled = false;
        if (err instanceof IndexEntryDecryptionError) {
          personalSyncWriteGate.markBlocked('decryption-failed', err.message);
        }
        console.warn('[CollabV3] Index delta poll failed:', err?.message || err);
      });
  }

  /**
   * Index replication, then the personal-state replay this connection still
   * owes -- on its own queue key, so it neither blocks nor fails the index
   * work. A complete mirror must not wait on read receipts, and losing them is
   * a degraded state rather than a reason to refuse the mirror.
   */
  async function runIndexReplicationWithPersonalState(options: { notifyListeners: boolean }): Promise<void> {
    await runIndexReplication(options);
    // A hint that arrived while the mirror was incomplete (or mid-drain) is
    // still recorded; now that coverage exists it can be acted on.
    scheduleHintedDrain();
    if (personalStateReplayGeneration === indexConnectionGeneration) return;
    void indexDrainQueue.run('personal-state', replayPersonalState).catch(err => {
      console.warn('[CollabV3] Personal state replay failed; read receipts and tracker personal state may be stale until the next sync:', (err as Error)?.message || err);
    });
  }

  // Helper to announce device to the index server
  function announceDevice(): void {
    // Get current device info (prefer callback for dynamic presence, fallback to static)
    const deviceInfo = localDeviceInfo();
    // Check both our flag AND the actual WebSocket readyState to avoid "Sent before connected" errors
    if (deviceInfo && indexWs && indexConnected && indexWs.readyState === WS_OPEN) {
      const announceMsg: ClientMessage = {
        type: 'deviceAnnounce',
        device: {
          ...deviceInfo,
          // Ensure lastActiveAt is current (callback may provide its own)
          lastActiveAt: deviceInfo.lastActiveAt ?? Date.now(),
        },
      };
      indexWs.send(JSON.stringify(announceMsg));
      // console.log('[CollabV3] Announced device:', deviceInfo.name);
    }
  }

  // Start periodic device re-announcement to handle server hibernation
  function startDeviceAnnounceInterval(): void {
    stopDeviceAnnounceInterval();
    if (config.deviceInfo || config.getDeviceInfo) {
      // Re-announce every 30 seconds to handle server hibernation and presence updates
      deviceAnnounceInterval = setInterval(() => {
        announceDevice();
      }, 30000);
    }
  }

  // Stop the periodic re-announcement
  function stopDeviceAnnounceInterval(): void {
    if (deviceAnnounceInterval) {
      clearInterval(deviceAnnounceInterval);
      deviceAnnounceInterval = null;
    }
  }

  // Start ping interval to keep WebSocket alive
  function startPingInterval(): void {
    stopPingInterval();
    pingInterval = setInterval(() => {
      if (indexWs && indexWs.readyState === WS_OPEN) {
        try {
          indexWs.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Connection is dead, will be handled by onclose
        }
      }
    }, 15000); // Every 15 seconds
  }

  function stopPingInterval(): void {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  function buildRoomId(personalMemberId: PersonalMemberId, suffix: string): string {
    return `org:${config.orgId}:user:${personalMemberId}:${suffix}`;
  }

  function getRoomId(sessionId: string): string {
    return buildRoomId(getPersonalMemberId(), `session:${sessionId}`);
  }

  function getIndexRoomId(): string {
    return buildRoomId(getPersonalMemberId(), 'index');
  }

  function getWebSocketUrl(roomId: string): string {
    const base = config.serverUrl.replace(/\/$/, '');
    // Convert http(s) to ws(s) if needed
    const wsBase = base.replace(/^http/, 'ws');
    return `${wsBase}/sync/${roomId}`;
  }

  function createInitialStatus(): SyncStatus {
    return {
      connected: false,
      syncing: false,
      lastSyncedAt: null,
      error: null,
    };
  }

  function updateStatus(sessionId: string, update: Partial<SyncStatus>): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.status = { ...session.status, ...update };
    session.statusListeners.forEach((cb) => cb(session.status));
  }

  async function encryptMessage(
    message: AgentMessage,
    key: CryptoKey
  ): Promise<EncryptedMessage> {
    // Trim large tool_result payloads before encryption so the SessionRoom
    // doesn't store full Bash/Read/Grep output for every step. Local raw log
    // keeps the unmodified content -- this only changes what crosses the wire.
    const { content: truncatedContent } = truncateContentForSync(
      message.content,
      message.source,
    );

    // Include hidden flag in encrypted content so it syncs to mobile
    const content = JSON.stringify({
      content: truncatedContent,
      metadata: message.metadata,
      hidden: message.hidden ?? false,
    });

    const { encrypted, iv } = await encrypt(content, key);

    // Use provider-assigned message ID if available (e.g., SDK uuid)
    // This is the most reliable deduplication method as the provider guarantees uniqueness
    // Fall back to hash-based ID for older messages or non-SDK providers
    let syncId: string;
    if (message.providerMessageId) {
      syncId = message.providerMessageId;
    } else {
      // Generate a STABLE sync ID from message content + timestamp
      // This prevents duplicate messages when the same message is synced multiple times
      // We hash: sessionId + timestamp + first 100 chars of content + direction
      const timestamp = message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : typeof message.createdAt === 'number'
          ? message.createdAt
          : Date.now();
      const contentPreview = message.content.substring(0, 100);
      const hashInput = `${message.sessionId}:${timestamp}:${message.direction}:${contentPreview}`;

      // Use SubtleCrypto to generate a stable hash
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(hashInput));
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      syncId = hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    return {
      id: syncId,
      sequence: 0, // Server assigns sequence
      createdAt: message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : typeof message.createdAt === 'number'
          ? message.createdAt
          : Date.now(),
      source: message.source as EncryptedMessage['source'],
      direction: message.direction as EncryptedMessage['direction'],
      encryptedContent: encrypted,
      iv,
      metadata: {},
    };
  }

  async function decryptMessage(
    encrypted: EncryptedMessage,
    key: CryptoKey
  ): Promise<AgentMessage> {
    const decrypted = await decrypt(encrypted.encryptedContent, encrypted.iv, key);
    const parsed = JSON.parse(decrypted);

    return {
      // Wire IDs are opaque hashes or provider UUIDs, not local row numbers.
      // The room's sequence is numeric and stable across history and replay.
      id: encrypted.sequence,
      providerMessageId: encrypted.id,
      sessionId: '', // Filled in by caller
      source: encrypted.source,
      direction: encrypted.direction,
      content: parsed.content,
      metadata: parsed.metadata,
      createdAt: new Date(encrypted.createdAt),
      hidden: parsed.hidden ?? false,
    };
  }

  function handleServerMessage(
    sessionId: string,
    data: string | ArrayBuffer
  ): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    try {
      const message: ServerMessage = JSON.parse(
        typeof data === 'string' ? data : new TextDecoder().decode(data)
      );

      switch (message.type) {
        case 'syncResponse':
          handleSyncResponse(sessionId, message);
          break;

        case 'messageBroadcast':
          handleMessageBroadcast(sessionId, message);
          break;

        case 'metadataBroadcast':
          // Note: async function, but we don't await to avoid blocking message processing
          handleMetadataBroadcast(sessionId, message).catch(err => {
            console.error('[CollabV3] Error handling metadata broadcast:', err);
          });
          break;

        case 'error':
          console.error(`[CollabV3] Server error for ${sessionId}:`, message.code, message.message);
          if (isFatalMessageSyncErrorCode(message.code)) {
            disableMessageSync(sessionId, message.code, message.message);
            break;
          }
          if (isSkippableMessageSyncErrorCode(message.code)) {
            // Drop this one message on the floor; the rest of the session keeps
            // syncing. Deliberately does not set status.error -- a single
            // rejected screenshot is not a session-level failure to surface.
            console.warn(
              `[CollabV3] Skipping a message the server refused for ${sessionId}` +
              ` (${message.code}): ${message.message}`
            );
            break;
          }
          updateStatus(sessionId, { error: message.message });
          break;
      }
    } catch (err) {
      console.error('[CollabV3] Error parsing server message:', err);
    }
  }

  async function handleSyncResponse(
    sessionId: string,
    response: Extract<ServerMessage, { type: 'syncResponse' }>
  ): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (isMessageSyncDisabled(sessionId)) return;

    // Update last sequence
    if (response.messages.length > 0) {
      session.lastSequence = response.messages[response.messages.length - 1].sequence;
    }

    // Cache metadata from sync response (includes queuedPrompts if present)
    if (response.metadata) {
      session.cachedMetadata = { ...session.cachedMetadata, ...response.metadata };
      // console.log('[CollabV3] Cached metadata from sync_response:', sessionId, 'queuedPrompts:', response.metadata.queuedPrompts?.length ?? 0);
    }

    // Decrypt and emit messages as remote changes
    if (session.encryptionKey && response.messages.length > 0) {
      // Collapse per-message decrypt failures into one summary. A burst here
      // means the server holds messages written under a PRIOR personal-key
      // seed epoch (keychain reset / reinstall / an unpaired device): the seed
      // is a local random 32 bytes (CredentialService) and the key is
      // PBKDF2(seed, 'nimbalyst:'+personalUserId) -- a different seed/user can't
      // authenticate them (AES-GCM OperationError). Unrecoverable without the
      // old seed. Record sessionId + createdAt range so the affected session and
      // epoch boundary are identifiable instead of 45 anonymous error lines.
      let decryptFailures = 0;
      let oldestFailedAt: number | null = null;
      let newestFailedAt: number | null = null;
      let firstFailedId = '';
      for (const encrypted of response.messages) {
        try {
          const decrypted = await decryptMessage(encrypted, session.encryptionKey);
          decrypted.sessionId = sessionId;

          session.changeListeners.forEach((cb) =>
            cb({ type: 'message_added', message: decrypted })
          );
        } catch {
          if (decryptFailures === 0) firstFailedId = encrypted.id;
          decryptFailures++;
          const at = new Date(encrypted.createdAt).getTime();
          if (!Number.isNaN(at)) {
            if (oldestFailedAt === null || at < oldestFailedAt) oldestFailedAt = at;
            if (newestFailedAt === null || at > newestFailedAt) newestFailedAt = at;
          }
        }
      }
      if (decryptFailures > 0) {
        console.warn(
          `[CollabV3] ${decryptFailures}/${response.messages.length} messages undecryptable for session ${sessionId} ` +
          `(prior personal-key seed epoch; unrecoverable). firstId=${firstFailedId} ` +
          `createdAt=${oldestFailedAt ? new Date(oldestFailedAt).toISOString() : '?'}..${newestFailedAt ? new Date(newestFailedAt).toISOString() : '?'}`,
        );
      }
    }

    // Update status
    updateStatus(sessionId, {
      syncing: response.hasMore,
      lastSyncedAt: Date.now(),
    });

    // Request more if needed
    if (response.hasMore && response.cursor) {
      const nextRequest: ClientMessage = {
        type: 'syncRequest',
        sinceSeq: parseInt(response.cursor, 10),
      };
      session.ws.send(JSON.stringify(nextRequest));
    }
  }

  async function handleMessageBroadcast(
    sessionId: string,
    broadcast: Extract<ServerMessage, { type: 'messageBroadcast' }>
  ): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session || !session.encryptionKey) return;

    try {
      const decrypted = await decryptMessage(broadcast.message, session.encryptionKey);
      decrypted.sessionId = sessionId;

      // Update sequence tracking
      session.lastSequence = Math.max(session.lastSequence, broadcast.message.sequence);

      // Emit to listeners
      session.changeListeners.forEach((cb) =>
        cb({ type: 'message_added', message: decrypted })
      );
    } catch (err) {
      console.error('[CollabV3] Failed to decrypt broadcast message:', err);
    }
  }

  async function handleMetadataBroadcast(
    sessionId: string,
    broadcast: Extract<ServerMessage, { type: 'metadataBroadcast' }>
  ): Promise<void> {
    // console.log('[CollabV3] Received metadata_broadcast for session:', sessionId, 'metadata:', JSON.stringify(broadcast.metadata));

    const session = sessions.get(sessionId);
    if (!session) {
      // console.log('[CollabV3] No session found for metadata_broadcast, sessionId:', sessionId);
      return;
    }

    // Cache the metadata broadcast (merge with existing cache)
    session.cachedMetadata = { ...session.cachedMetadata, ...broadcast.metadata };

    const metadata: Partial<SyncedSessionMetadata> = {
      mode: broadcast.metadata.mode,
      provider: broadcast.metadata.provider,
      model: broadcast.metadata.model,
      // NOTE: Do NOT set updatedAt here. Metadata broadcasts (read state, isExecuting,
      // context) are not content changes and should not bump the sort timestamp.
      // Only message appends should change updatedAt. The previous fallback to
      // Date.now() caused sessions to jump to the top of the iOS list when any
      // metadata was updated.
      pendingExecution: broadcast.metadata.pendingExecution,
      isExecuting: broadcast.metadata.isExecuting,
    };

    // Decrypt client metadata (context usage, pending prompt state, etc.)
    if (broadcast.metadata.encryptedClientMetadata && broadcast.metadata.clientMetadataIv && session.encryptionKey) {
      try {
        const clientMeta = await decryptClientMetadata(broadcast.metadata.encryptedClientMetadata, broadcast.metadata.clientMetadataIv, session.encryptionKey);
        metadata.currentContext = clientMeta.currentContext;
        metadata.hasPendingPrompt = clientMeta.hasPendingPrompt;
        if (clientMeta.draftInput !== undefined) metadata.draftInput = clientMeta.draftInput;
        if (clientMeta.draftUpdatedAt !== undefined) metadata.draftUpdatedAt = clientMeta.draftUpdatedAt;
      } catch (err) {
        console.error('[CollabV3] Failed to decrypt client metadata from broadcast:', err);
      }
    }

    // Decrypt title - encrypted titles are required
    if (broadcast.metadata.encryptedTitle && broadcast.metadata.titleIv && session.encryptionKey) {
      try {
        metadata.title = await decryptTitle(broadcast.metadata.encryptedTitle, broadcast.metadata.titleIv, session.encryptionKey);
      } catch (err) {
        console.error('[CollabV3] Failed to decrypt title:', err);
        metadata.title = 'Untitled';
      }
    } else if (broadcast.metadata.encryptedTitle) {
      // Encrypted title present but no key - show as untitled
      metadata.title = 'Untitled';
    }
    // If no encryptedTitle field at all, don't update the title

    // Decrypt queued prompts - encrypted prompts are required
    if (broadcast.metadata.encryptedQueuedPrompts && broadcast.metadata.encryptedQueuedPrompts.length > 0 && session.encryptionKey) {
      try {
        metadata.queuedPrompts = await decryptQueuedPrompts(broadcast.metadata.encryptedQueuedPrompts, session.encryptionKey);
      } catch (err) {
        console.error('[CollabV3] Failed to decrypt queued prompts:', err);
        // Can't decrypt - don't update queued prompts
      }
    } else if (Array.isArray(broadcast.metadata.encryptedQueuedPrompts)) {
      metadata.queuedPrompts = [];
    }
    // If no encryptedQueuedPrompts field, don't update queued prompts.

    // console.log('[CollabV3] Notifying', session.changeListeners.size, 'change listeners with queuedPrompts:', metadata.queuedPrompts?.length ?? 0);

    session.changeListeners.forEach((cb) =>
      cb({ type: 'metadata_updated', metadata })
    );
  }

  // Process pending operations that were queued before connection was established
  function processPendingOperations(): void {
    if (!indexWs || !indexConnected) return;

    // console.log('[CollabV3] Processing', pendingOperations.length, 'pending operations');

    // Process in order they were queued
    while (pendingOperations.length > 0) {
      const op = pendingOperations.shift()!;
      if (op.type === 'sessions') {
        // Call the sync function directly (now that we're connected)
        // Note: async but we don't await to avoid blocking
        doSyncSessionsToIndex(op.data, op.options).catch(err => {
          console.error('[CollabV3] Error in doSyncSessionsToIndex:', err);
        });
      }
      // Projects are auto-calculated from sessions in CollabV3, so nothing to do
    }
  }

  // Connect to index for session list updates
  async function connectToIndex(): Promise<void> {
    if (indexWs && indexConnected) {
      // Already connected and healthy, nothing to do
      return;
    }

    if (indexAuthBlocked) {
      // Auth is known-bad; throwing here lets callers (e.g. ad-hoc
      // sendSessionControlMessage) skip work that would never succeed.
      const err = new Error('CollabV3 index connection blocked: JWT/personal-member mismatch');
      (err as any).code = 'AUTH_MISMATCH';
      throw err;
    }

    // Clean up zombie WebSocket: created but never connected (or connection dropped
    // silently). Without this, we'd return early and never establish a fresh connection.
    if (indexWs && !indexConnected) {
      console.log('[CollabV3] connectToIndex() - closing zombie WebSocket (readyState:', indexWs.readyState, ')');
      try {
        indexWs.onclose = null; // Prevent onclose from triggering reconnect loop
        indexWs.onerror = null;
        indexWs.close();
      } catch (_) { /* ignore close errors */ }
      indexWs = null;
    }

    // Get fresh JWT before connecting. Throws AUTH_MISMATCH if the JWT cannot
    // succeed against the configured room (caught below to set indexAuthBlocked).
    let jwt: PersonalJwt;
    try {
      ({ jwt } = await ensureFreshJwt());
    } catch (err) {
      if (isAuthMismatchError(err)) {
        indexAuthBlocked = true;
        if (indexReconnectTimer) {
          clearTimeout(indexReconnectTimer);
          indexReconnectTimer = null;
        }
      }
      throw err;
    }

    const indexRoomId = getIndexRoomId();
    console.log('[CollabV3] connectToIndex() roomId:', indexRoomId, 'orgId:', config.orgId, 'personalMemberId:', getPersonalMemberId());
    const url = getWebSocketUrl(indexRoomId);
    // Pass JWT via query parameter (WebSocket doesn't support custom headers in browsers)
    const wsUrl = appendSyncClientParams(`${url}?token=${encodeURIComponent(jwt)}`);

    indexWs = openWebSocket(wsUrl);

    /**
     * Tracks whether THIS WebSocket instance ever fired `onopen`. Pre-open
     * failures (OS still negotiating DHCP, JWT refresh 401, TLS handshake
     * rejection) shouldn't advance the exponential-backoff counter -- we
     * want to keep retrying fast while the network is genuinely unavailable.
     * Only a drop *after* the WS successfully opened counts as a real
     * backoff-worthy failure.
     */
    let reachedOpen = false;

    indexWs.onopen = () => {
      reachedOpen = true;
      indexConnected = true;
      indexReconnectAttempts = 0;
      indexPreOpenFailures = 0;
      // console.log('[CollabV3] Connected to index');

      // Send device announcement if device info is provided
      announceDevice();

      // Process any operations that were queued while connecting
      processPendingOperations();

      // Set up periodic re-announcement to handle server hibernation
      // The server may hibernate and lose device state, so we re-announce every 30 seconds
      startDeviceAnnounceInterval();

      // Keep connection alive with pings
      startPingInterval();

      // Start the stability window. If the WS stays open for INDEX_STABILITY_MS
      // we treat the connection as truly usable and mark it ready. This is what
      // gates the cross-provider cascade -- we've seen the index `open` then
      // error within 7ms when the OS hasn't finished switching network interfaces.
      if (indexStabilityTimer) clearTimeout(indexStabilityTimer);
      indexStabilityTimer = setTimeout(() => {
        indexStabilityTimer = null;
        if (indexWs && indexConnected) {
          markIndexReady();
          resubscribeWantedSessions();
        }
      }, INDEX_STABILITY_MS);
    };

    indexWs.onclose = (event: CloseEvent) => {
      stopPingInterval();
      indexConnected = false;
      indexWs = null;
      // A new connection is no proof of what survived on the server side, so
      // nothing may be suppressed as "already published" across it.
      indexPublicationGate.reset();
      // Drop any in-flight page request and make late responses unusable. The
      // mirror itself survives: revisions are server-owned, so a reconnect
      // resumes with a delta instead of re-bootstrapping. Capability is
      // re-probed because the server on the other end may have been upgraded.
      indexConnectionGeneration++;
      indexProtocolCapability = 'unknown';
      cancelPendingIndexPage('Index connection closed while a page request was in flight');
      maxHintedRevision = undefined;
      hintDrainScheduled = false;
      cancelPendingPersonalStatePage('Index connection closed while a personal state page was in flight');
      clearIndexReady();
      stopDeviceAnnounceInterval();

      // Server rejections (bad/expired JWT, policy violations) arrive as a
      // close frame, not an error event. Log code/reason so auth failures
      // aren't opaque next time. 1006 is a synthetic "abnormal closure"
      // emitted by the WS client when the underlying socket dies; that's
      // network/transport, not server policy.
      console.log(
        `[CollabV3] Disconnected from index (code=${event?.code ?? 'unknown'}, reason="${event?.reason ?? ''}", wasClean=${event?.wasClean ?? 'unknown'}, reachedOpen=${reachedOpen})`,
      );
      // Pre-open failure: the network likely isn't actually up yet. Keep
      // reconnect attempts fast by not letting the failure bump the backoff
      // exponent. If we're in a flaky post-wake window we want to keep probing
      // quickly instead of slipping to the 30s cap.
      scheduleIndexReconnect({ preOpenFailure: !reachedOpen });
    };

    indexWs.onerror = (event) => {
      // WS `onerror` carries almost no info -- the actionable signal (close
      // code / reason) arrives on `onclose`, which always fires after error.
      // Log a stable summary here and let `onclose` add the close-frame
      // details so we never get the previous "[object Object]" placeholder.
      const errorInfo = typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent
        ? { message: event.message, error: event.error }
        : { type: event.type };
      console.error('[CollabV3] Index WebSocket error:', errorInfo, 'URL:', redactSyncUrl(wsUrl));
    };

    indexWs.onmessage = async (event) => {
      try {
        const message: ServerMessage = JSON.parse(
          typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
        );

        switch (message.type) {
          case 'indexSyncResponse': {
            const totalCount = (message as any).totalSessionCount;
            if (totalCount !== undefined && totalCount !== message.sessions.length) {
              console.warn(`[CollabV3] INDEX TRUNCATION DETECTED! Server COUNT(*)=${totalCount} but received ${message.sessions.length} sessions`);
            } else {
              // console.log(`[CollabV3] Received indexSyncResponse: ${message.sessions.length} sessions (server total: ${totalCount ?? 'unknown'})`);
            }
            if (pendingIndexFetch) {
              const pending = pendingIndexFetch;
              pendingIndexFetch = null;
              try {
                const snapshot = await decodeLegacyIndexSnapshot(message.sessions, message.projects, config.encryptionKey);
                // Commit only once every row decrypted. A partial commit would
                // hand reconciliation a view the server never held, and
                // reconciliation republishes whatever it believes is missing.
                for (const row of snapshot.rows) {
                  sessionIndexCache.set(row.decrypted.sessionId, row.cacheEntry);
                  // The server just told us what it holds; that is the value a
                  // subsequent patch has to differ from to be worth sending.
                  indexPublicationGate.recordPublished(row.decrypted.sessionId, indexPatchSignatureForEntry(row.cacheEntry));
                }
                personalSyncWriteGate.markVerified();
                pending.resolve({
                  // The legacy response IS the complete snapshot -- that has
                  // always been its meaning, and absence-based reconciliation has
                  // always relied on it. It carries no tombstones, so the caller
                  // cannot distinguish a remote delete from a never-published row
                  // on this path; that is why v2 exists.
                  complete: true,
                  indexProtocolVersion: 1,
                  sessions: snapshot.rows.map((row) => row.decrypted),
                  projects: snapshot.projects,
                });
              } catch (err) {
                if (err instanceof IndexEntryDecryptionError) {
                  // #1117: a row this key cannot read is a key problem on this
                  // device, not server state to clean up. Nothing is deleted,
                  // nothing is cached, and publication stays closed until a
                  // complete read succeeds.
                  personalSyncWriteGate.markBlocked('decryption-failed', err.message);
                  console.warn(`[CollabV3] ${err.message}. The server index is left untouched and personal-sync writes are paused on this device.`);
                }
                pending.reject(err instanceof Error ? err : new Error(String(err)));
              }
            }
            break;
          }

          case 'indexBroadcast': {
            // Another device updated a session. The row is decrypted in full
            // before anything local changes: a broadcast this key cannot read
            // keeps the last good cached row and closes publication (#1117),
            // instead of writing 'unknown' / 'Untitled' placeholders into the
            // cache and out to the renderer.
            const entry = message.session;
            let row: DecryptedLegacyIndexRow;
            try {
              row = await decryptSessionIndexEntry(entry, config.encryptionKey);
            } catch (err) {
              if (!(err instanceof IndexEntryDecryptionError)) throw err;
              personalSyncWriteGate.markBlocked('decryption-failed', err.message);
              console.warn(`[CollabV3] Ignoring index broadcast for session ${entry.sessionId}: ${err.message}. The cached row is preserved and personal-sync writes are paused on this device.`);
              break;
            }
            const decryptedEntry = row.cacheEntry;

            // Cache the decrypted entry
            sessionIndexCache.set(entry.sessionId, decryptedEntry);
            // Broadcast rows are the server's own view of the row (ours echoed
            // back, or another device's write). Track it so the gate compares
            // against current server state rather than a stale local send.
            indexPublicationGate.recordPublished(entry.sessionId, indexPatchSignatureForEntry(decryptedEntry));
            // console.log('[CollabV3] Received indexBroadcast for session:', entry.sessionId,
            //   'queuedPrompts:', decryptedEntry.queuedPrompts?.length ?? 0,
            //   'pendingExecution:', decryptedEntry.pendingExecution,
            //   'isExecuting:', decryptedEntry.isExecuting);

            // Apply any pending metadata updates that were waiting for this session
            applyPendingMetadataUpdates(entry.sessionId).catch(err => {
              console.error('[CollabV3] Error applying pending metadata updates:', err);
            });

            // Notify all index change listeners with decrypted data
            indexChangeListeners.forEach((callback) => {
              try {
                callback(entry.sessionId, {
                  ...decryptedEntry,
                  sessionId: decryptedEntry.sessionId,
                });
              } catch (err) {
                console.error('[CollabV3] Error in index change listener:', err);
              }
            });
            break;
          }

          case 'projectBroadcast':
            // New project created by another device - log for now
            // Desktop clients currently don't need to update local state since projects are
            // derived from local workspace folders, not server state
            // Note: Cannot log decrypted name as it would require async decryption
            console.log('[CollabV3] New project received from another device');
            break;

          case 'devicesList':
            // console.log('[CollabV3] Received devices list:', message.devices.length, 'devices');
            // Replace all tracked devices with the server's list
            connectedDevices.clear();
            for (const device of message.devices) {
              connectedDevices.set(device.deviceId, device);
            }
            notifyDeviceStatusChange();
            break;

          case 'deviceJoined':
            // console.log('[CollabV3] Device joined:', message.device.name, message.device.type);
            connectedDevices.set(message.device.deviceId, message.device);
            notifyDeviceStatusChange();
            break;

          case 'deviceLeft':
            // console.log('[CollabV3] Device left:', message.deviceId);
            connectedDevices.delete(message.deviceId);
            notifyDeviceStatusChange();
            break;

          case 'mobilePushResult': {
            const pending = pendingMobilePushes.get(message.requestId);
            if (!pending) break;
            clearTimeout(pending.timer);
            pendingMobilePushes.delete(message.requestId);
            pending.resolve({
              accepted: message.accepted,
              attemptedCount: message.attemptedCount,
              deliveredCount: message.deliveredCount,
              skipped: message.skipped,
              rejection: message.rejection,
            });
            break;
          }

          case 'createSessionRequestBroadcast': {
            // Another device (mobile) requested session creation
            const ourDeviceId = localDeviceId();
            if (message.targetDeviceId && message.targetDeviceId !== ourDeviceId) break;
            // Captured BEFORE the decryption awaits below. The server binds this
            // claim to the socket that delivered the broadcast, and a listener
            // that samples the generation after the await reads whatever socket
            // exists by then -- so a disconnect mid-decrypt looks, from the
            // listener's side, like a claim it still holds.
            const receiptGeneration = indexConnectionGeneration;
            // Decrypt projectId - required for encrypted wire protocol
            let projectId: string;
            if (message.request.encryptedProjectId && message.request.projectIdIv && config.encryptionKey) {
              try {
                projectId = await decryptProjectId(message.request.encryptedProjectId, message.request.projectIdIv, config.encryptionKey);
              } catch (err) {
                console.error('[CollabV3] Failed to decrypt projectId in create request:', err);
                projectId = 'unknown';
              }
            } else {
              projectId = 'unknown';
            }

            // Decrypt the initial prompt if present
            let initialPrompt: string | undefined;
            if (message.request.encryptedInitialPrompt && message.request.initialPromptIv && config.encryptionKey) {
              try {
                initialPrompt = await decrypt(message.request.encryptedInitialPrompt, message.request.initialPromptIv, config.encryptionKey);
              } catch (err) {
                console.error('[CollabV3] Failed to decrypt initial prompt:', err);
              }
            }

            const decryptedRequest: CreateSessionRequest = {
              requestId: message.request.requestId,
              projectId,
              initialPrompt,
              sessionType: message.request.sessionType,
              parentSessionId: message.request.parentSessionId,
              provider: message.request.provider,
              model: message.request.model,
              agentRole: message.request.agentRole,
              targetDeviceId: message.targetDeviceId,
              timestamp: message.request.timestamp,
              receiptGeneration,
            };

            // Notify all listeners (desktop will handle this)
            createSessionRequestListeners.forEach((callback) => {
              try {
                callback(decryptedRequest);
              } catch (err) {
                console.error('[CollabV3] Error in create session request listener:', err);
              }
            });
            break;
          }

          case 'createSessionResponseBroadcast': {
            // Desktop responded to our session creation request
            const response: CreateSessionResponse = {
              requestId: message.response.requestId,
              success: message.response.success,
              sessionId: message.response.sessionId,
              error: message.response.error,
            };

            // Debug logging - uncomment if needed
            // console.log('[CollabV3] Received create_session_response:', response.requestId, 'success:', response.success);

            // Notify all listeners (mobile will handle this)
            createSessionResponseListeners.forEach((callback) => {
              try {
                callback(response);
              } catch (err) {
                console.error('[CollabV3] Error in create session response listener:', err);
              }
            });
            break;
          }

          case 'voiceToolRequestBroadcast': {
            // Another device (mobile) asked the desktop to run a voice tool.
            if (!config.encryptionKey) {
              console.error('[CollabV3] Cannot handle voice tool request - no encryption key');
              break;
            }
            try {
              const projectId = await decryptProjectId(
                message.request.encryptedProjectId,
                message.request.projectIdIv,
                config.encryptionKey,
              );
              const toolName = await decrypt(
                message.request.encryptedToolName,
                message.request.toolNameIv,
                config.encryptionKey,
              );
              const argsJson = await decrypt(
                message.request.encryptedArgs,
                message.request.argsIv,
                config.encryptionKey,
              );
              const decryptedRequest: VoiceToolRequest = {
                requestId: message.request.requestId,
                projectId,
                toolName,
                argsJson,
                timestamp: message.request.timestamp,
              };
              voiceToolRequestListeners.forEach((callback) => {
                try {
                  callback(decryptedRequest);
                } catch (err) {
                  console.error('[CollabV3] Error in voice tool request listener:', err);
                }
              });
            } catch (err) {
              console.error('[CollabV3] Failed to decrypt voice tool request:', err);
            }
            break;
          }

          case 'voiceToolResponseBroadcast': {
            // Desktop responded to our voice tool request.
            if (!config.encryptionKey) {
              console.error('[CollabV3] Cannot handle voice tool response - no encryption key');
              break;
            }
            let resultJson: string | undefined;
            let error: string | undefined;
            try {
              if (message.response.encryptedResult && message.response.resultIv) {
                resultJson = await decrypt(message.response.encryptedResult, message.response.resultIv, config.encryptionKey);
              }
              if (message.response.encryptedError && message.response.errorIv) {
                error = await decrypt(message.response.encryptedError, message.response.errorIv, config.encryptionKey);
              }
            } catch (err) {
              console.error('[CollabV3] Failed to decrypt voice tool response:', err);
            }
            const response: VoiceToolResponse = {
              requestId: message.response.requestId,
              success: message.response.success,
              resultJson,
              error,
            };
            voiceToolResponseListeners.forEach((callback) => {
              try {
                callback(response);
              } catch (err) {
                console.error('[CollabV3] Error in voice tool response listener:', err);
              }
            });
            break;
          }

          case 'createWorktreeRequestBroadcast': {
            // Another device (mobile) requested worktree creation
            const ourDeviceId = localDeviceId();
            if (message.targetDeviceId && message.targetDeviceId !== ourDeviceId) break;
            let projectId: string;
            if (message.request.encryptedProjectId && message.request.projectIdIv && config.encryptionKey) {
              try {
                projectId = await decryptProjectId(message.request.encryptedProjectId, message.request.projectIdIv, config.encryptionKey);
              } catch (err) {
                console.error('[CollabV3] Failed to decrypt projectId in worktree request:', err);
                projectId = 'unknown';
              }
            } else {
              projectId = 'unknown';
            }

            const decryptedRequest: CreateWorktreeRequest = {
              requestId: message.request.requestId,
              projectId,
              targetDeviceId: message.targetDeviceId,
              timestamp: message.request.timestamp,
            };

            console.log('[CollabV3] Received createWorktreeRequest from mobile:', decryptedRequest.requestId);

            createWorktreeRequestListeners.forEach((callback) => {
              try {
                callback(decryptedRequest);
              } catch (err) {
                console.error('[CollabV3] Error in create worktree request listener:', err);
              }
            });
            break;
          }

          case 'createWorktreeResponseBroadcast': {
            // Response to worktree creation - just log for now (iOS doesn't need callback)
            console.log('[CollabV3] Received createWorktreeResponse:', message.response.requestId, 'success:', message.response.success);
            break;
          }

          case 'sessionControlBroadcast': {
            // Generic session control message from another device
            const ourDeviceId = localDeviceId();
            if (message.message.targetDeviceId && message.message.targetDeviceId !== ourDeviceId) break;
            const controlMessage: SessionControlMessage = {
              sessionId: message.message.sessionId,
              type: message.message.messageType,
              payload: message.message.payload,
              timestamp: message.message.timestamp,
              sentBy: message.message.sentBy,
              sentByDeviceId: message.message.sentByDeviceId,
              targetDeviceId: message.message.targetDeviceId,
            };

            console.log('[CollabV3] Received sessionControl:', controlMessage.sessionId, controlMessage.type);

            // Notify all listeners
            sessionControlMessageListeners.forEach((callback) => {
              try {
                callback(controlMessage);
              } catch (err) {
                console.error('[CollabV3] Error in session control message listener:', err);
              }
            });
            break;
          }

          case 'settingsSyncBroadcast': {
            // Another device synced settings (e.g., desktop syncing API key to mobile)
            const payload = message.settings;

            // Don't process our own broadcasts
            const ourDeviceId = localDeviceId();
            if (ourDeviceId && payload.deviceId === ourDeviceId) {
              break;
            }

            // Decrypt settings
            if (!config.encryptionKey) {
              console.error('[CollabV3] Cannot decrypt settings - no encryption key');
              break;
            }

            try {
              const decryptedSettingsJson = await decrypt(
                payload.encryptedSettings,
                payload.settingsIv,
                config.encryptionKey
              );
              const settings: SyncedSettings = JSON.parse(decryptedSettingsJson);

              console.log('[CollabV3] Received settings sync from device:', payload.deviceId, 'version:', settings.version);

              // Notify all listeners
              settingsSyncListeners.forEach((callback) => {
                try {
                  callback(settings);
                } catch (err) {
                  console.error('[CollabV3] Error in settings sync listener:', err);
                }
              });
            } catch (err) {
              console.error('[CollabV3] Failed to decrypt settings:', err);
            }
            break;
          }

          case 'readReceiptBroadcast':
            await handleReadReceiptBroadcast(message.receipt);
            break;

          case 'trackerPersonalStateBroadcast':
            await handleTrackerPersonalStateBroadcast(message.state);
            break;

          case 'indexPageResponse': {
            const pending = pendingIndexPage;
            if (!pending || pending.requestId !== message.requestId) {
              // A response for a request we are not waiting on (cancelled,
              // timed out, or from a previous connection). Applying it would
              // merge rows into a mirror whose drain has moved on.
              console.warn('[CollabV3] Ignoring indexPageResponse for unknown requestId:', message.requestId);
              break;
            }
            clearTimeout(pending.timer);
            pendingIndexPage = null;
            if (pending.generation !== indexConnectionGeneration) {
              pending.reject(new Error('[CollabV3] Index page response arrived after a reconnect; discarding'));
              break;
            }
            // Answering at all proves the server speaks v2.
            indexProtocolCapability = 'v2';
            // Envelope has to match what we asked for: a bootstrap page applied
            // as a delta (or vice versa) would be merged under the wrong
            // coverage rules.
            if (message.protocolVersion !== 2) {
              pending.reject(new Error(`[CollabV3] indexPageResponse declared protocol version ${String(message.protocolVersion)}`));
              break;
            }
            if (message.mode !== pending.mode) {
              pending.reject(new Error(`[CollabV3] indexPageResponse mode '${String(message.mode)}' does not match the requested '${pending.mode}'`));
              break;
            }
            if (!Array.isArray(message.entries)) {
              pending.reject(new Error('[CollabV3] indexPageResponse carried no entries array'));
              break;
            }
            pending.resolve(message);
            break;
          }

          case 'personalStatePageResponse': {
            const pending = pendingPersonalStatePage;
            if (!pending || pending.requestId !== message.requestId) {
              console.warn('[CollabV3] Ignoring personalStatePageResponse for unknown requestId:', message.requestId);
              break;
            }
            clearTimeout(pending.timer);
            pendingPersonalStatePage = null;
            if (pending.generation !== indexConnectionGeneration) {
              pending.reject(new Error('[CollabV3] Personal state page arrived after a reconnect; discarding'));
              break;
            }
            pending.resolve(message);
            break;
          }

          case 'indexSessionExpired': {
            const expired = message as unknown as { sessionId: string; activityAt: number };
            if (!Number.isFinite(expired.activityAt) || typeof expired.sessionId !== 'string') break;
            rejectedIndexActivity.set(expired.sessionId, expired.activityAt);
            if (rejectedIndexActivity.size > 1000) rejectedIndexActivity.delete(rejectedIndexActivity.keys().next().value!);
            const cached = sessionIndexCache.get(expired.sessionId);
            if (cached && sessionActivityAt(cached) === expired.activityAt) {
              sessionIndexCache.delete(expired.sessionId);
              indexPublicationGate.invalidate(expired.sessionId);
            }
            break;
          }

          case 'indexChangesAvailable': {
            // A hint, not a cursor. Remember the high-water mark unconditionally
            // -- including while a bootstrap is still in flight -- then let the
            // scheduler decide when a drain can actually run.
            if (typeof message.revision === 'number') {
              maxHintedRevision = Math.max(maxHintedRevision ?? 0, message.revision);
            }
            scheduleHintedDrain();
            break;
          }

          case 'error':
            console.error('[CollabV3] Index error:', message.code, message.message);
            if (message.code === 'update_required') {
              // The server refuses personal-sync writes from this build. Only a
              // newer build clears this; reads and presence continue.
              personalSyncWriteGate.markBlocked('update-required', message.message);
            }
            if (pendingPersonalStatePage
              && (message.requestId === undefined || message.requestId === pendingPersonalStatePage.requestId)) {
              const pending = pendingPersonalStatePage;
              pendingPersonalStatePage = null;
              clearTimeout(pending.timer);
              // An old server has no personalStatePageRequest handler. The
              // replay is skipped rather than failing the connection: v2 index
              // replication is unaffected, and legacy servers replay these
              // streams on indexSyncRequest anyway.
              pending.reject(new Error(`${message.code}: ${message.message}`));
            }
            if (pendingIndexPage
              && (message.requestId === undefined || message.requestId === pendingIndexPage.requestId)) {
              // The server has no handler for `indexPageRequest`. This is the
              // only error that authorizes the legacy fallback.
              const unsupported = message.code === 'unknown_message_type'
                || message.code === 'unsupported_message'
                || message.code === 'unsupported_protocol_version';
              const pending = pendingIndexPage;
              pendingIndexPage = null;
              clearTimeout(pending.timer);
              pending.reject(unsupported
                ? new IndexProtocolUnsupportedError(`${message.code}: ${message.message}`)
                : new Error(message.message));
            }
            if (pendingIndexFetch) {
              pendingIndexFetch.reject(new Error(message.message));
              pendingIndexFetch = null;
            }
            break;
        }
      } catch (err) {
        console.error('[CollabV3] Error parsing index message:', err);
      }
    };
  }

  // Log the config being used
  // console.log('[CollabV3] Initializing with config:', {
  //   serverUrl: config.serverUrl,
  //   personalMemberId: config.personalMemberId,
  //   hasEncryptionKey: !!config.encryptionKey,
  // });

  // Start index connection. If the JWT mismatches the configured personalMemberId,
  // ensureFreshJwt sets indexAuthBlocked and throws -- we swallow it here so we
  // don't fire an unhandled promise rejection at startup. A later explicit
  // reconnectIndex() (network change / settings update / auth refresh) will
  // clear indexAuthBlocked and try again. Other errors fall through to the
  // existing scheduleIndexReconnect path via the onclose handler.
  connectToIndex().catch(err => {
    if (isAuthMismatchError(err)) {
      console.warn('[CollabV3] Initial index connect blocked: JWT/personal-member mismatch. Waiting for explicit reconnect trigger.');
      return;
    }
    console.error('[CollabV3] Initial index connect failed:', err);
    scheduleIndexReconnect({ preOpenFailure: true });
  });

  // Sync messages to a session room (internal function)
  async function syncSessionMessages(
    sessionId: string,
    messages: AgentMessage[],
    metadata?: { title?: string; provider?: string; model?: string; mode?: string }
  ): Promise<void> {
    if (isMessageSyncDisabled(sessionId)) return;
    const replayActivityAt = messages.reduce((latest, message) => Math.max(latest, message.createdAt instanceof Date ? message.createdAt.getTime() : typeof message.createdAt === 'number' ? message.createdAt : 0), 0);
    if (!isRetainedSession(replayActivityAt, Date.now(), SESSION_TRANSCRIPT_TTL_MS)) return;
    if (!config.encryptionKey) {
      console.error('[CollabV3] Cannot sync messages - no encryption key');
      return;
    }
    if (withholdPersonalSyncWrite('transcript upload')) return;

    // console.log('[CollabV3] syncSessionMessages() - CREATING TEMP WebSocket for session', sessionId, 'with', messages.length, 'messages');

    // Get fresh JWT before connecting
    const { jwt } = await ensureFreshJwt();

    // Connect to session room
    const roomId = getRoomId(sessionId);
    const url = getWebSocketUrl(roomId);
    // Pass JWT via query parameter (WebSocket doesn't support custom headers in browsers)
    const wsUrl = appendSyncClientParams(`${url}?token=${encodeURIComponent(jwt)}`);

    return new Promise((resolve, reject) => {
      const ws = openWebSocket(wsUrl);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error('Timeout syncing messages'));
        }
      }, 30000);

      ws.onopen = async () => {
        try {
          if (isMessageSyncDisabled(sessionId)) {
            clearTimeout(timeout);
            resolved = true;
            ws.close();
            resolve();
            return;
          }

          // Retain the original message order. The replay declaration grants
          // only this connection permission to send older rows for current work.
          ws.send(JSON.stringify({ type: 'beginSessionReplay', activityAt: replayActivityAt }));

          // First update metadata if provided
          if (metadata) {
            const wireMetadata: Partial<SessionMetadata> = {
              provider: metadata.provider,
              model: metadata.model,
              mode: metadata.mode as 'agent' | 'planning' | undefined,
            };
            // Title must be encrypted on the wire. The server stores ciphertext
            // only; sending plaintext here would leak titles into DO SQLite
            // (see also IndexRoom.encrypted_title for the index-side equivalent).
            if (metadata.title && config.encryptionKey) {
              const { encryptedTitle, titleIv } = await encryptTitle(metadata.title, config.encryptionKey);
              wireMetadata.encryptedTitle = encryptedTitle;
              wireMetadata.titleIv = titleIv;
            }
            const metadataMsg: ClientMessage = {
              type: 'updateMetadata',
              metadata: wireMetadata,
            };
            ws.send(JSON.stringify(metadataMsg));
          }

          // Send each message
          for (const message of messages) {
            if (resolved || isMessageSyncDisabled(sessionId)) break;
            if (!shouldSyncMessageForSessionRoom(message.source, message.metadata, message.content)) {
              continue;
            }
            const encrypted = await encryptMessage(message, config.encryptionKey!);
            const clientMsg: ClientMessage = { type: 'appendMessage', message: encrypted };
            ws.send(JSON.stringify(clientMsg));
          }

          // Small delay to ensure messages are processed
          await new Promise(r => setTimeout(r, 500));

          clearTimeout(timeout);
          resolved = true;
          ws.close();
          resolve();
        } catch (err) {
          clearTimeout(timeout);
          resolved = true;
          ws.close();
          reject(err);
        }
      };

      ws.onerror = (event) => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          // WebSocket onerror receives a DOM Event, not an Error object.
          // Extract meaningful info to avoid "Uncaught Error: undefined" dialogs.
          const errorInfo = typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent
            ? event.message || 'WebSocket error'
            : 'WebSocket connection error';
          reject(new Error(`[CollabV3] ${errorInfo} for session ${sessionId}`));
        }
      };

      ws.onmessage = (event) => {
        if (resolved) return;
        try {
          const message: ServerMessage = JSON.parse(
            typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
          );
          if (message.type === 'error' && message.code === 'session_expired') {
            clearTimeout(timeout);
            resolved = true;
            ws.close();
            resolve();
            return;
          }
          if (message.type !== 'error' || !isFatalMessageSyncErrorCode(message.code)) return;

          disableMessageSync(sessionId, message.code, message.message);
          clearTimeout(timeout);
          resolved = true;
          ws.close();
          resolve();
        } catch {
          // Non-JSON and unrelated server messages do not affect batch sync.
        }
      };

      ws.onclose = () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve();
        }
      };
    });
  }

  // Batch sync session messages with delay to prevent server overload (internal function).
  // When messageSyncRequests + getMessagesForSync are provided, messages are loaded lazily
  // per batch instead of pre-loaded, so PGLite isn't blocked for 30+ seconds on bulk syncs.
  async function doBatchSyncSessionMessages(
    sessionsData: SessionIndexData[],
    messageSyncRequests?: Array<{ sessionId: string; sinceTimestamp: number }>,
    getMessagesForSync?: (requests: Array<{ sessionId: string; sinceTimestamp: number }>) => Promise<Map<string, any[]>>,
  ): Promise<void> {
    const batchSize = 3;
    const delayMs = 1000;

    // Lazy loading path: load messages per batch from the database
    if (messageSyncRequests && getMessagesForSync) {
      const requestMap = new Map(messageSyncRequests.map(r => [r.sessionId, r]));
      const sessionMap = new Map(sessionsData.map(s => [s.id, s]));
      const sessionIds = messageSyncRequests.map(r => r.sessionId).filter(id => sessionMap.has(id));

      // console.log('[CollabV3] Lazy batch syncing messages for', sessionIds.length, 'sessions in batches of', batchSize);

      for (let i = 0; i < sessionIds.length; i += batchSize) {
        const batchIds = sessionIds.slice(i, i + batchSize).filter(id => isRetainedSession(sessionMap.get(id)?.updatedAt, Date.now(), SESSION_TRANSCRIPT_TTL_MS));
        if (!batchIds.length) continue;
        const batchRequests = batchIds.map(id => requestMap.get(id)!);

        // Load messages for just this batch
        const messagesBySession = await getMessagesForSync(batchRequests);

        // Sync each session's messages
        await Promise.all(batchIds.map(sessionId => {
          const msgs = messagesBySession.get(sessionId);
          const session = sessionMap.get(sessionId);
          if (!msgs || msgs.length === 0 || !session) return Promise.resolve();
          return syncSessionMessages(sessionId, msgs, {
            title: session.title,
            provider: session.provider,
            model: session.model,
            mode: session.mode,
          });
        }));

        // Delay before next batch
        if (i + batchSize < sessionIds.length) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      // console.log('[CollabV3] Lazy batch sync complete');
      return;
    }

    // Legacy path: messages already pre-loaded on session objects
    const sessionsWithMessages = sessionsData.filter(s => s.messages && s.messages.length > 0);

    for (let i = 0; i < sessionsWithMessages.length; i += batchSize) {
      const batch = sessionsWithMessages.slice(i, i + batchSize);

      await Promise.all(batch.map(session =>
        syncSessionMessages(session.id, session.messages!, {
          title: session.title,
          provider: session.provider,
          model: session.model,
          mode: session.mode,
        })
      ));

      if (i + batchSize < sessionsWithMessages.length) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  // Helper function to actually sync sessions to index (requires connection)
  async function doSyncSessionsToIndex(sessionsData: SessionIndexData[], options?: {
    syncMessages?: boolean;
    messageSyncRequests?: Array<{ sessionId: string; sinceTimestamp: number }>;
    getMessagesForSync?: (requests: Array<{ sessionId: string; sinceTimestamp: number }>) => Promise<Map<string, any[]>>;
  }): Promise<void> {
    if (!indexWs || !indexConnected) {
      console.error('[CollabV3] doSyncSessionsToIndex called but not connected!');
      return;
    }
    if (withholdPersonalSyncWrite('bulk index publish')) return;

    sessionsData = sessionsData.filter(session => isRetainedSession(session.updatedAt) && !wasIndexActivityRejected(session.id, session.updatedAt));
    if (!sessionsData.length) return;

    // console.log('[CollabV3] Syncing', sessionsData.length, 'sessions to index');

    // The socket and connection generation this batch was built against. The
    // encryption below can take seconds for a large batch, and `indexWs` is
    // module state that a reconnect replaces underneath us.
    const socket = indexWs;
    const generation = indexConnectionGeneration;

    // Nothing here touches the cache or the gate until after the send: this
    // path runs OUTSIDE the per-session publish queue, so a live metadata patch
    // can be built, sent, and cached while this batch is still encrypting.
    // Whichever build is stale at send time drops its entry instead of
    // overwriting the newer one on the server and in the cache.
    const built: Array<{
      sessionId: string;
      entry: SessionIndexEntry;
      cacheEntry: CachedSessionIndex;
      signature: string;
      publishSeq: number;
    }> = [];

    // Build all entries, encrypting sensitive fields
    await Promise.all(sessionsData.map(async session => {
      const projectId = session.workspaceId ?? 'default';

      // Encrypt projectId - encryption is required
      if (!config.encryptionKey) {
        throw new Error('[CollabV3] Cannot send session: no encryption key for projectId');
      }
      // Captured before the first await, alongside the cache read it is built from.
      const publishSeq = publishSequencer.read(session.id);
      const { encryptedProjectId, projectIdIv } = await encryptProjectId(projectId, config.encryptionKey);

      // Check if we have cached execution/prompt state for this session
      const existingCache = sessionIndexCache.get(session.id);
      const pending = pendingMetadataUpdates.get(session.id);
      const cachedIsExecuting = pending?.isExecuting ?? existingCache?.isExecuting;
      const cachedHasPendingPrompt = pending?.hasPendingPrompt ?? existingCache?.hasPendingPrompt;
      const cachedLastReadAt = pending?.lastReadAt ?? existingCache?.lastReadAt;
      const cachedQueuedPrompts = pending && 'queuedPrompts' in pending
        ? pending.queuedPrompts
        : existingCache?.queuedPrompts;
      const cachedQueuedPromptCount = cachedQueuedPrompts?.length ?? existingCache?.queuedPromptCount;

      const entry: SessionIndexEntry = {
        sessionId: session.id,
        encryptedProjectId,
        projectIdIv,
        provider: session.provider,
        model: session.model,
        mode: session.mode as SessionIndexEntry['mode'],
        // Plaintext relationship/flag fields (incl. agentRole + createdBySessionId
        // for mobile meta-agent grouping). Single source of truth + regression lock:
        // sessionIndexEntryFields.ts / __tests__/sessionIndexEntryFields.test.ts.
        //
        // hostDeviceId comes from the row and only from the row. A session
        // written before host attribution existed stays unattributed: publishing
        // a row is not evidence of owning it, and two upgraded installs holding
        // the same pre-upgrade session would otherwise each claim it in turn.
        ...buildSyncedSessionIndexFields(session),
        // The bulk reconciliation query does not count messages (the COUNT join
        // cost seconds on a large database), so `session.messageCount` is a
        // placeholder zero unless the caller says otherwise. Publishing that
        // zero overwrote the server's real count on every metadata-only sync.
        // v2 omits it and the server keeps what it has; a legacy server has no
        // COALESCE, so send the last count the server itself told us, falling
        // back to the local value only when we have never seen one.
        ...(resolvePublishedMessageCount(session, existingCache) !== undefined
          ? { messageCount: resolvePublishedMessageCount(session, existingCache) }
          : {}),
        // lastMessageAt keeps advancing per message so mobile unread state
        // (Session.hasUnread: lastMessageAt > lastReadAt) stays live mid-turn.
        lastMessageAt: session.updatedAt,
        createdAt: session.createdAt,
        // updatedAt is the mobile sort key and is held steady while a session
        // executes, so per-message drift doesn't reshuffle the iOS list every
        // sync pass. Turn boundaries still move it via
        // pushExecutionStateToMobile. See sessionSortTimestamp.ts (NIM-2167).
        updatedAt: resolveIndexSortTimestamp({
          localUpdatedAt: session.updatedAt,
          cachedUpdatedAt: existingCache?.updatedAt,
          isExecuting: cachedIsExecuting,
        }),
        isExecuting: cachedIsExecuting,
        queuedPromptCount: cachedQueuedPromptCount,
        lastReadAt: cachedLastReadAt,
      };

      // Encrypt title - encryption is required
      if (session.title) {
        const { encryptedTitle, titleIv } = await encryptTitle(session.title, config.encryptionKey);
        entry.encryptedTitle = encryptedTitle;
        entry.titleIv = titleIv;
      }

      await attachQueuedPromptsToIndexEntry(entry, cachedQueuedPrompts, cachedQueuedPromptCount);

      // Encrypt client metadata (context usage, pending prompt state, etc.)
      const rawClientMeta = buildClientMetadataFromRaw(session.metadata, {
        hasBeenNamed: session.hasBeenNamed,
      });
      // Merge in transient fields that are not reliably persisted in PGLite before sync runs.
      const clientMeta: ClientMetadata | undefined =
        rawClientMeta ||
        cachedHasPendingPrompt !== undefined ||
        pending?.currentContext !== undefined ||
        pending?.phase !== undefined ||
        pending?.tags !== undefined ||
        pending?.draftInput !== undefined ||
        pending?.draftUpdatedAt !== undefined ||
        pending?.hasBeenNamed !== undefined
          ? {
              ...rawClientMeta,
              currentContext: pending?.currentContext ?? rawClientMeta?.currentContext,
              hasPendingPrompt: cachedHasPendingPrompt,
              phase: pending?.phase ?? rawClientMeta?.phase,
              tags: pending?.tags ?? rawClientMeta?.tags,
              draftInput: pending?.draftInput ?? rawClientMeta?.draftInput,
              draftUpdatedAt: pending?.draftUpdatedAt ?? rawClientMeta?.draftUpdatedAt,
              hasBeenNamed: pending?.hasBeenNamed ?? rawClientMeta?.hasBeenNamed,
            }
          : undefined;
      if (clientMeta) {
        const { encryptedClientMetadata, clientMetadataIv } = await encryptClientMetadata(clientMeta, config.encryptionKey);
        entry.encryptedClientMetadata = encryptedClientMetadata;
        entry.clientMetadataIv = clientMetadataIv;
      }

      // Cache the entry with DECRYPTED values for local use
      // Preserve isExecuting and hasPendingPrompt from existing cache or pending updates
      const cacheEntry: CachedSessionIndex = {
        sessionId: session.id,
        projectId: projectId, // Store decrypted
        title: session.title, // Store decrypted
        provider: session.provider,
        model: session.model,
        mode: session.mode as CachedSessionIndex['mode'],
        sessionType: session.sessionType,
        parentSessionId: session.parentSessionId,
        worktreeId: session.worktreeId,
        hostDeviceId: entry.hostDeviceId,
        agentRole: session.agentRole,
        createdBySessionId: session.createdBySessionId ?? undefined,
        isArchived: session.isArchived,
        isPinned: session.isPinned,
        branchedFromSessionId: session.branchedFromSessionId,
        branchPointMessageId: session.branchPointMessageId,
        branchedAt: session.branchedAt,
        messageCount: session.messageCountKnown === false
          ? existingCache?.messageCount ?? session.messageCount
          : session.messageCount,
        lastMessageAt: session.updatedAt,
        createdAt: session.createdAt,
        // Mirror the value actually sent, not the local one -- otherwise the
        // next sync pass reads a drifted "cached" timestamp and the mid-turn
        // hold in resolveIndexSortTimestamp leaks. (NIM-2167)
        updatedAt: entry.updatedAt,
        currentContext: clientMeta?.currentContext,
        isExecuting: cachedIsExecuting,
        queuedPrompts: cachedQueuedPrompts,
        queuedPromptCount: cachedQueuedPromptCount,
        hasPendingPrompt: cachedHasPendingPrompt,
        phase: clientMeta?.phase,
        tags: clientMeta?.tags,
        lastReadAt: cachedLastReadAt,
        draftInput: clientMeta?.draftInput,
        draftUpdatedAt: clientMeta?.draftUpdatedAt,
        hasBeenNamed: clientMeta?.hasBeenNamed,
      };
      built.push({
        sessionId: session.id,
        entry,
        cacheEntry,
        signature: indexPatchSignatureForEntry(cacheEntry),
        publishSeq,
      });
    }));

    const fresh = built.filter(item =>
      isPublishStillCurrent(item.sessionId, socket, generation, item.publishSeq, 'bulk index entry'));
    const entries = fresh.map(item => item.entry);

    // Use batch API if we have multiple sessions, otherwise single update
    if (entries.length > 1) {
      const msg: ClientMessage = { type: 'indexBatchUpdate', sessions: entries };
      const msgStr = JSON.stringify(msg);
      console.log('[CollabV3] Sending batch index update:', entries.length, 'sessions, message length:', msgStr.length);
      socket.send(msgStr);
    } else if (entries.length === 1) {
      const msg: ClientMessage = { type: 'indexUpdate', session: entries[0] };
      socket.send(JSON.stringify(msg));
    }
    // Only now, after the batch is actually on the wire, does local state move:
    // the cache, the suppression signature, and the publish sequence.
    for (const item of fresh) {
      sessionIndexCache.set(item.sessionId, item.cacheEntry);
      indexPublicationGate.recordPublished(item.sessionId, item.signature);
      noteSessionRowPublished(item.sessionId);

      // Apply any pending metadata updates (e.g., isExecuting set before the
      // cache was populated). Fire-and-forget: the encrypted entry is already sent.
      applyPendingMetadataUpdates(item.sessionId).catch(err => {
        console.error('[CollabV3] Error applying pending metadata updates:', err);
      });
    }

    // Sync messages if requested (fire-and-forget, catch errors to avoid unhandled rejections)
    if (options?.syncMessages === true) {
      doBatchSyncSessionMessages(sessionsData, options.messageSyncRequests, options.getMessagesForSync)
        .catch(err => console.warn('[CollabV3] Batch message sync failed:', err?.message || err));
    }
  }

  // Hard limit on concurrent session WebSocket connections to prevent performance issues
  const MAX_SESSION_CONNECTIONS = 10;

  // Idle timeout before a connection can be evicted (5 minutes)
  const IDLE_EVICTION_TIMEOUT_MS = 5 * 60 * 1000;

  // Create provider object
  const provider: SyncProvider = {
    async connect(sessionId: string): Promise<void> {
      const pending = sessionConnectionsInFlight.get(sessionId);
      if (pending) return pending;
      const existing = sessions.get(sessionId);
      if (existing && !sessionTransportUsable(existing)) this.disconnect(sessionId);
      // Register the promise before auth or socket creation can yield. Every
      // caller must wait for OPEN, including a message racing session creation.
      const attempt = Promise.resolve().then(async () => {
      if (isMessageSyncDisabled(sessionId)) return;
      // Track this session as wanted so we re-subscribe after reconnects.
      // Do this before the short-circuit so callers resubscribing an already-connected
      // session (e.g. after the Map got deleted on onclose) still register intent.
      wantedSessions.add(sessionId);
      if (sessions.has(sessionId)) {
        // console.log(`[CollabV3] connect() - already connected to session ${sessionId}`);
        return; // Already connected
      }

      // Short-circuit when the JWT/personal-member mismatch latch is set. The server
      // would reject any session WebSocket against this room, and an active
      // agent streams ~10 messages/sec -- without this guard every message
      // hit `ensureFreshJwt()`, threw AUTH_MISMATCH, and flooded main.log
      // (1686/4986 lines during a single mobile-build session on 2026-05-21).
      // The latch clears on reconnectIndex() / disconnectAll(), so legitimate
      // signals (network change, settings update, auth refresh) still
      // unblock subsequent connects.
      if (indexAuthBlocked) {
        const err = new Error('CollabV3 session connection blocked: JWT/personal-member mismatch');
        (err as any).code = 'AUTH_MISMATCH';
        throw err;
      }

      // Enforce hard limit on concurrent connections - try to evict idle connection first
      if (sessions.size >= MAX_SESSION_CONNECTIONS) {
        // Find the oldest idle connection that exceeds the idle timeout
        const now = Date.now();
        let oldestIdleSessionId: string | null = null;
        let oldestIdleTime = Infinity;

        for (const [sid, sess] of sessions) {
          const idleTime = now - sess.lastActivity;
          if (idleTime >= IDLE_EVICTION_TIMEOUT_MS && idleTime > (now - oldestIdleTime)) {
            // This session has been idle longer than the threshold
            if (sess.lastActivity < oldestIdleTime) {
              oldestIdleTime = sess.lastActivity;
              oldestIdleSessionId = sid;
            }
          }
        }

        if (oldestIdleSessionId) {
          // Evict the oldest idle connection to make room
          console.log(`[CollabV3] connect() - evicting idle session ${oldestIdleSessionId} (idle for ${Math.round((now - oldestIdleTime) / 1000)}s) to make room for ${sessionId}`);
          this.disconnect(oldestIdleSessionId);
        } else {
          // No idle connections to evict - reject the new connection
          console.warn(`[CollabV3] connect() - REJECTING connection for ${sessionId}, already at max (${MAX_SESSION_CONNECTIONS} connections) and no idle sessions to evict`);
          return;
        }
      }

      // Log stack trace to identify what's creating connections
      // const stack = new Error().stack?.split('\n').slice(2, 6).join('\n') || '';
      // console.log(`[CollabV3] connect() - CREATING NEW WebSocket for session ${sessionId} (${sessions.size + 1}/${MAX_SESSION_CONNECTIONS})\n${stack}`);

      // Get fresh JWT before connecting. If ensureFreshJwt throws
      // AUTH_MISMATCH, set the latch so subsequent connect() calls
      // short-circuit (defense in depth alongside the check above; this
      // covers the case where the per-session connect() is the first
      // sync call in the process and connectToIndex() hasn't latched
      // yet).
      let jwt: PersonalJwt;
      try {
        ({ jwt } = await ensureFreshJwt());
      } catch (err) {
        if (isAuthMismatchError(err)) {
          indexAuthBlocked = true;
        }
        throw err;
      }

      const roomId = getRoomId(sessionId);
      if (sessionConnectionsInFlight.get(sessionId) !== attempt) {
        throw new Error('Session connection was cancelled');
      }
      const url = getWebSocketUrl(roomId);
      // Pass JWT via query parameter (WebSocket doesn't support custom headers in browsers)
      const wsUrl = appendSyncClientParams(`${url}?token=${encodeURIComponent(jwt)}`);

      return new Promise<void>((resolve, reject) => {
        const ws = openWebSocket(wsUrl);

        const session: SessionConnection = {
          ws,
          status: createInitialStatus(),
          statusListeners: sessionStatusListeners.get(sessionId) ?? new Set(),
          changeListeners: sessionChangeListeners.get(sessionId) ?? new Set(),
          lastSequence: 0,
          encryptionKey: config.encryptionKey,
          lastActivity: Date.now(),
          nodeCredentialExpiresAt: isNodeAccessToken(jwt) ? decodeNodeAccessTokenClaims(jwt).exp * 1000 : undefined,
        };

        sessions.set(sessionId, session);
        sessionStatusListeners.set(sessionId, session.statusListeners);
        sessionChangeListeners.set(sessionId, session.changeListeners);

        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
          ws.close();
          if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        }, 10000);

        ws.onopen = () => {
          clearTimeout(timeout);
          updateStatus(sessionId, { connected: true, syncing: true });

          // Request initial sync
          const syncRequest: ClientMessage = { type: 'syncRequest' };
          ws.send(JSON.stringify(syncRequest));

          resolve();
        };

        ws.onclose = (event: CloseEvent) => {
          clearTimeout(timeout);
          reject(new Error('Session connection closed before opening'));
          if (sessions.get(sessionId) !== session) return;
          // Auth rejections (expired/invalid JWT) arrive here as a close
          // frame, not as an error event. Logging code/reason makes the
          // root cause visible the next time something goes wrong.
          console.log(
            `[CollabV3] Session WebSocket closed for ${sessionId} (code=${event?.code ?? 'unknown'}, reason="${event?.reason ?? ''}", wasClean=${event?.wasClean ?? 'unknown'})`,
          );
          updateStatus(sessionId, { connected: false });
          sessions.delete(sessionId);
          if (!session.statusListeners.size) sessionStatusListeners.delete(sessionId);
          if (!session.changeListeners.size) sessionChangeListeners.delete(sessionId);
        };

        ws.onerror = (event) => {
          // onerror itself carries little -- the close frame that follows has
          // the actionable code/reason. Keep this log as a breadcrumb only.
          const errorInfo = typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent
            ? { message: event.message, error: event.error }
            : { type: event.type, target: redactSyncUrl((event.target as WebSocket)?.url) };
          console.error(`[CollabV3] WebSocket error for ${sessionId}:`, errorInfo, 'URL:', redactSyncUrl(wsUrl));
          updateStatus(sessionId, { connected: false, error: 'Connection error' });
        };

        ws.onmessage = (event) => {
          // Update activity timestamp on message receive
          const sess = sessions.get(sessionId);
          if (sess) sess.lastActivity = Date.now();
          handleServerMessage(sessionId, event.data);
        };
      });
      });
      sessionConnectionsInFlight.set(sessionId, attempt);
      try { await attempt; }
      finally {
        if (sessionConnectionsInFlight.get(sessionId) === attempt) sessionConnectionsInFlight.delete(sessionId);
      }
    },

    disconnect(sessionId: string): void {
      // Caller explicitly no longer wants this session -- drop intent so it
      // isn't resubscribed on the next index reconnect.
      wantedSessions.delete(sessionId);
      sessionConnectionsInFlight.delete(sessionId);
      const session = sessions.get(sessionId);
      if (!session) return;

      session.ws.close();
      sessions.delete(sessionId);
    },

    disconnectAll(): void {
      wantedSessions.clear();
      sessionConnectionsInFlight.clear();
      for (const sessionId of sessions.keys()) {
        this.disconnect(sessionId);
      }
      sessionStatusListeners.clear();
      sessionChangeListeners.clear();

      if (indexReconnectTimer) {
        clearTimeout(indexReconnectTimer);
        indexReconnectTimer = null;
      }
      indexReconnectAttempts = 0;
      indexPreOpenFailures = 0;
      indexAuthBlocked = false;
      clearIndexReady();
      indexReadyListeners.clear();
      if (indexWs) {
        indexWs.close();
        indexWs = null;
        indexConnected = false;
      }
      indexPublicationGate.reset();
      indexConnectionGeneration++;
      indexProtocolCapability = 'unknown';
      cancelPendingIndexPage('Sync disconnected while a page request was in flight');
      maxHintedRevision = undefined;
      hintDrainScheduled = false;
      cancelPendingPersonalStatePage('Sync disconnected while a personal state page was in flight');
      // Full teardown (sign-out / account switch): the replicated mirror and
      // its cursor belong to that account and must not survive into another.
      indexMirror.reset();
      indexMirrorMemberId = undefined;
    },

    isConnected(sessionId: string): boolean {
      return sessionTransportUsable(sessions.get(sessionId));
    },

    isAuthMismatched(): boolean {
      return indexAuthBlocked;
    },

    getStatus(sessionId: string): SyncStatus {
      const session = sessions.get(sessionId);
      return session?.status ?? createInitialStatus();
    },

    onStatusChange(sessionId: string, callback: (status: SyncStatus) => void): () => void {
      const listeners = sessionStatusListeners.get(sessionId) ?? new Set();
      sessionStatusListeners.set(sessionId, listeners);
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
        if (!listeners.size && !sessions.has(sessionId)) sessionStatusListeners.delete(sessionId);
      };
    },

    onRemoteChange(sessionId: string, callback: (change: SessionChange) => void): () => void {
      const listeners = sessionChangeListeners.get(sessionId) ?? new Set();
      sessionChangeListeners.set(sessionId, listeners);
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
        if (!listeners.size && !sessions.has(sessionId)) sessionChangeListeners.delete(sessionId);
      };
    },

    /**
     * Failures are REPORTED, never thrown: every existing caller is
     * fire-and-forget, and throwing would turn each one into an unhandled
     * rejection. A caller that has to know (the headless node retains an
     * unpublished transcript row and retries it on reconnect) reads the outcome.
     */
    async pushChange(sessionId: string, change: SessionChange): Promise<PushChangeOutcome> {
      if (isMessageSyncDisabled(sessionId) && change.type === 'message_added') {
        return { published: false, reason: 'message sync is disabled for this session', retryable: false };
      }
      const session = sessions.get(sessionId);
      const sessionConnected = sessionTransportUsable(session);

      // For metadata-only updates (like hasPendingPrompt, isExecuting), we can push to the
      // index room even without a session room connection. The session room is only opened
      // when a user enters a session to sync messages - but index metadata updates should
      // always go through as long as the index WebSocket is connected.
      const canPushIndexOnly = change.type === 'metadata_updated' && indexWs && indexConnected && config.encryptionKey;

      if (!sessionConnected && !canPushIndexOnly) {
        console.warn('[CollabV3] Cannot push change - not connected:', sessionId, 'sessionExists:', !!session, 'indexConnected:', indexConnected, 'hasKey:', !!config.encryptionKey);
        return { published: false, reason: 'not connected', retryable: true };
      }
      // console.log('[CollabV3] pushChange:', sessionId, 'type:', change.type, 'sessionConnected:', sessionConnected, 'indexOnly:', !sessionConnected && canPushIndexOnly);

      let clientMessage: ClientMessage | undefined;

      switch (change.type) {
        case 'message_added': {
          if (!session?.encryptionKey) {
            console.warn('[CollabV3] Cannot push message - no encryption key or session room not connected');
            return { published: false, reason: 'session room has no encryption key', retryable: true };
          }
          if (!shouldSyncMessageForSessionRoom(change.message.source, change.message.metadata, change.message.content, change.message.hidden)) {
            // Deliberately not sent. Not retryable: it would be filtered again.
            return { published: false, reason: 'filtered from session-room sync', retryable: false };
          }
          try {
            const encrypted = await encryptMessage(change.message, session.encryptionKey);
            // console.log('[CollabV3] Encrypted message:', {
            //   id: encrypted.id,
            //   contentLength: encrypted.encryptedContent.length,
            //   ivLength: encrypted.iv.length,
            //   source: encrypted.source,
            //   direction: encrypted.direction,
            // });
            clientMessage = { type: 'appendMessage', message: encrypted };
          } catch (err) {
            console.error('[CollabV3] Failed to encrypt message:', err);
            // Deterministic: the same row would fail the same way.
            return { published: false, reason: 'encryption failed', retryable: false };
          }
          break;
        }

        case 'metadata_updated': {
          const metadata: Partial<SessionMetadata> = {};

          // Encrypt title
          if (change.metadata.title && config.encryptionKey) {
            const { encryptedTitle, titleIv } = await encryptTitle(change.metadata.title, config.encryptionKey);
            metadata.encryptedTitle = encryptedTitle;
            metadata.titleIv = titleIv;
          }

          if (change.metadata.provider) metadata.provider = change.metadata.provider;
          if (change.metadata.model) metadata.model = change.metadata.model;
          if (change.metadata.mode) metadata.mode = change.metadata.mode as SessionMetadata['mode'];
          if ('pendingExecution' in change.metadata) {
            metadata.pendingExecution = change.metadata.pendingExecution;
          }
          if ('isExecuting' in change.metadata) {
            metadata.isExecuting = change.metadata.isExecuting;
          }
          // Encrypt queued prompts
          if ('queuedPrompts' in change.metadata) {
            if (change.metadata.queuedPrompts && change.metadata.queuedPrompts.length > 0) {
              if (!config.encryptionKey) {
                throw new Error('[CollabV3] Cannot send queued prompts: no encryption key available');
              }
              metadata.encryptedQueuedPrompts = await encryptQueuedPrompts(change.metadata.queuedPrompts, config.encryptionKey);
            } else {
              metadata.encryptedQueuedPrompts = [];
            }
          }
          // Encrypt client metadata (context usage, pending prompt state, phase, tags, draft, etc.)
          if ('draftInput' in change.metadata) {
            // console.log('[CollabV3] metadata_updated has draftInput:', (change.metadata as any).draftInput?.substring(0, 50));
          }
          const hasClientMetaFields = ('currentContext' in change.metadata && change.metadata.currentContext) ||
            ('hasPendingPrompt' in change.metadata) ||
            ('phase' in change.metadata) ||
            ('tags' in change.metadata) ||
            ('draftInput' in change.metadata) ||
            ('hasBeenNamed' in change.metadata);
          if (hasClientMetaFields && config.encryptionKey) {
            const cached = sessionIndexCache.get(sessionId);
            const clientMeta: ClientMetadata = {
              currentContext: ('currentContext' in change.metadata ? change.metadata.currentContext : cached?.currentContext) || undefined,
              hasPendingPrompt: 'hasPendingPrompt' in change.metadata ? change.metadata.hasPendingPrompt : cached?.hasPendingPrompt,
              phase: 'phase' in change.metadata ? (change.metadata as any).phase : cached?.phase,
              tags: 'tags' in change.metadata ? (change.metadata as any).tags : cached?.tags,
              draftInput: 'draftInput' in change.metadata ? (change.metadata as any).draftInput : cached?.draftInput,
              draftUpdatedAt: 'draftUpdatedAt' in change.metadata ? (change.metadata as any).draftUpdatedAt : cached?.draftUpdatedAt,
              hasBeenNamed: 'hasBeenNamed' in change.metadata ? (change.metadata as any).hasBeenNamed : cached?.hasBeenNamed,
            };
            if (clientMeta.draftInput !== undefined) {
              // console.log('[CollabV3] Encrypting clientMeta with draftInput, sending to index');
            }
            const encrypted = await encryptClientMetadata(clientMeta, config.encryptionKey);
            metadata.encryptedClientMetadata = encrypted.encryptedClientMetadata;
            metadata.clientMetadataIv = encrypted.clientMetadataIv;
          }
          // Only send to session room if connected; index-only updates skip this
          if (sessionConnected) {
            clientMessage = { type: 'updateMetadata', metadata };
          }
          break;
        }

        case 'session_deleted':
          // Send delete to session room
          clientMessage = { type: 'deleteSession' };
          break;
      }

      // Tracks whether the session-room write actually happened, for the outcome
      // returned at the end. Only `message_added` has nowhere else to land: a
      // metadata update still reaches the index below.
      let sessionRoomOutcome: PushChangeOutcome | undefined;

      // Send to session room (if connected, we have a message to send, and
      // this device is allowed to publish personal-sync ciphertext at all)
      if (clientMessage && sessionConnected && !withholdPersonalSyncWrite('session room write')) {
        try {
          const json = JSON.stringify(clientMessage);
          // console.log('[CollabV3] Sending message, length:', json.length);
          if (clientMessage.type === 'updateMetadata') {
            const activity = change.type === 'metadata_updated'
              ? change.metadata.updatedAt ?? sessionActivityAt(sessionIndexCache.get(sessionId) ?? {})
              : sessionActivityAt(sessionIndexCache.get(sessionId) ?? {});
            if (isRetainedSession(activity, Date.now(), SESSION_TRANSCRIPT_TTL_MS)) {
              session.ws.send(JSON.stringify({ type: 'beginSessionReplay', activityAt: activity }));
            }
          }
          session.ws.send(json);
          // Update activity timestamp on message send
          session.lastActivity = Date.now();
        } catch (err) {
          console.error('[CollabV3] Failed to send message:', err);
          sessionRoomOutcome = { published: false, reason: 'session room send failed', retryable: true };
        }
      } else if (change.type === 'message_added') {
        // The only branch where a message row silently goes nowhere: either the
        // session room is not connected or the personal-sync write gate is
        // holding writes back. Both clear on reconnect, so this is retryable.
        sessionRoomOutcome = {
          published: false,
          reason: sessionConnected
            ? 'personal-sync writes are withheld'
            : 'session room is not connected',
          retryable: true,
        };
      }

      // Handle index updates based on change type
      if (indexWs && indexConnected && !withholdPersonalSyncWrite('index change')) {
        if (change.type === 'session_deleted') {
          // Delete from index and cache
          sessionIndexCache.delete(sessionId);
          // A delete/recreate is not an ordinary metadata merge -- the recreated
          // row must publish in full, never be suppressed against the deleted
          // row's projection.
          indexPublicationGate.invalidate(sessionId);
          const indexDeleteMsg: ClientMessage = { type: 'indexDelete', sessionId: sessionId };
          // console.log('[CollabV3] Sending index_delete for session:', sessionId);
          indexWs.send(JSON.stringify(indexDeleteMsg));
        } else if (change.type === 'metadata_updated') {
          const meta = change.metadata;
          const cached = sessionIndexCache.get(sessionId);
          // Only use a fresh timestamp if the caller explicitly set updatedAt.
          // For read-status-only updates (lastReadAt), we must NOT bump updatedAt
          // or the session will resort to the top of the list on other devices.
          const updatedAt = meta.updatedAt ?? undefined;

          // Build index entry by merging with cached data
          // This allows partial updates (e.g., just title) to work
          // console.log('[CollabV3] metadata_updated index path: sessionId:', sessionId, 'hasCached:', !!cached, 'indexConnected:', indexConnected);
          if (cached) {
            // Merge partial update with cached entry (cache stores decrypted values).
            // Every column / metadata key in SYNC_RELEVANT_FIELDS must be merged here
            // or partial updates from SyncedSessionStore.updateMetadata silently drop
            // on the floor before reaching iOS.
            const updatedCache: CachedSessionIndex = {
              ...cached,
              projectId: meta.workspaceId ?? cached.projectId,
              title: meta.title ?? cached.title,
              provider: meta.provider ?? cached.provider,
              model: meta.model ?? cached.model,
              mode: (meta.mode ?? cached.mode) as CachedSessionIndex['mode'],
              sessionType: 'sessionType' in meta ? (meta as any).sessionType : cached.sessionType,
              parentSessionId: 'parentSessionId' in meta ? meta.parentSessionId : cached.parentSessionId,
              worktreeId: 'worktreeId' in meta ? (meta as any).worktreeId : cached.worktreeId,
              hostDeviceId: 'hostDeviceId' in meta ? meta.hostDeviceId : cached.hostDeviceId,
              // Meta-agent grouping fields: apply when the update carries them,
              // otherwise preserve the cached value (also held by the `...cached`
              // spread above). createdBySessionId is normalized null -> undefined.
              agentRole: 'agentRole' in meta ? meta.agentRole : cached.agentRole,
              createdBySessionId: 'createdBySessionId' in meta ? (meta.createdBySessionId ?? undefined) : cached.createdBySessionId,
              isArchived: 'isArchived' in meta ? meta.isArchived : cached.isArchived,
              isPinned: 'isPinned' in meta ? (meta as any).isPinned : cached.isPinned,
              lastMessageAt: updatedAt ?? cached.lastMessageAt,
              updatedAt: updatedAt ?? cached.updatedAt,
              pendingExecution: 'pendingExecution' in meta ? meta.pendingExecution : cached.pendingExecution,
              isExecuting: 'isExecuting' in meta ? meta.isExecuting : cached.isExecuting,
              queuedPrompts: 'queuedPrompts' in meta ? meta.queuedPrompts : cached.queuedPrompts,
              queuedPromptCount: 'queuedPrompts' in meta
                ? meta.queuedPrompts?.length ?? 0
                : cached.queuedPromptCount,
              currentContext: 'currentContext' in meta ? meta.currentContext : cached.currentContext,
              hasPendingPrompt: 'hasPendingPrompt' in meta ? meta.hasPendingPrompt : cached.hasPendingPrompt,
              phase: 'phase' in meta ? (meta as any).phase : cached.phase,
              tags: 'tags' in meta ? (meta as any).tags : cached.tags,
              lastReadAt: 'lastReadAt' in meta ? (meta as any).lastReadAt : cached.lastReadAt,
              draftInput: 'draftInput' in meta ? (meta as any).draftInput : cached.draftInput,
              draftUpdatedAt: 'draftUpdatedAt' in meta ? (meta as any).draftUpdatedAt : cached.draftUpdatedAt,
              hasBeenNamed: 'hasBeenNamed' in meta ? (meta as any).hasBeenNamed : cached.hasBeenNamed,
            };
            if (isIndexClientMetadataOnlyUpdate(meta)) {
              await sendIndexClientMetadataPatch(updatedCache);
            } else {
              await sendIndexUpdate(updatedCache);
            }
          } else if (meta.title && meta.provider) {
            // New session - need at least title and provider
            const now = updatedAt;
            if (now === undefined || !isRetainedSession(now)) {
              // Too old to publish to the index. The session-room write above
              // already happened (or reported why not), so the outcome stands.
              return sessionRoomOutcome ?? { published: true };
            }
            const newEntry: CachedSessionIndex = {
              sessionId: sessionId,
              projectId: meta.workspaceId ?? 'default',
              title: meta.title,
              provider: meta.provider,
              model: meta.model,
              mode: meta.mode as CachedSessionIndex['mode'],
              sessionType: meta.sessionType,
              parentSessionId: meta.parentSessionId,
              worktreeId: (meta as any).worktreeId,
              hostDeviceId: meta.hostDeviceId,
              // Meta-agent grouping fields (parity with bulk path's
              // buildSyncedSessionIndexFields + sendIndexUpdate). Without these a
              // freshly-created meta agent/child reaches the server/phone ungrouped
              // until the next full bulk resync. createdBySessionId is normalized
              // null -> undefined to match the helper.
              agentRole: meta.agentRole,
              createdBySessionId: meta.createdBySessionId ?? undefined,
              isArchived: meta.isArchived,
              isPinned: (meta as any).isPinned,
              messageCount: 0,
              lastMessageAt: now,
              createdAt: now,
              updatedAt: now,
              pendingExecution: meta.pendingExecution,
              isExecuting: meta.isExecuting,
              queuedPrompts: meta.queuedPrompts,
              queuedPromptCount: meta.queuedPrompts?.length,
              currentContext: meta.currentContext,
              hasPendingPrompt: meta.hasPendingPrompt,
              phase: (meta as any).phase,
              tags: (meta as any).tags,
              lastReadAt: (meta as any).lastReadAt,
              draftInput: (meta as any).draftInput,
              draftUpdatedAt: (meta as any).draftUpdatedAt,
              hasBeenNamed: (meta as any).hasBeenNamed,
            };
            await sendIndexUpdate(newEntry);
          } else {
            // No cached data and missing required fields for a full update.
            // Queue the partial update to be applied when the session is cached.
            // This handles cases like isExecuting being set before syncSessionsToIndex runs,
            // or title updates from session naming that arrive before the session is indexed.
            const hasPartialUpdate =
              'isExecuting' in meta ||
              'pendingExecution' in meta ||
              meta.title !== undefined ||
              'sessionType' in meta ||
              'parentSessionId' in meta ||
              'worktreeId' in meta ||
              'hostDeviceId' in meta ||
              'isArchived' in meta ||
              'isPinned' in meta ||
              'queuedPrompts' in meta ||
              'currentContext' in meta ||
              'hasPendingPrompt' in meta ||
              'phase' in meta ||
              'tags' in meta ||
              'lastReadAt' in meta ||
              'draftInput' in meta ||
              'draftUpdatedAt' in meta ||
              'hasBeenNamed' in meta ||
              'updatedAt' in meta;
            if (hasPartialUpdate) {
              // console.log('[CollabV3] Queueing partial metadata update for session:', sessionId, { isExecuting: meta.isExecuting, pendingExecution: meta.pendingExecution, title: meta.title });
              const existing = pendingMetadataUpdates.get(sessionId) || {};
              if ('isExecuting' in meta) existing.isExecuting = meta.isExecuting;
              if ('pendingExecution' in meta) existing.pendingExecution = meta.pendingExecution;
              if (meta.title !== undefined) existing.title = meta.title;
              if ('sessionType' in meta) existing.sessionType = meta.sessionType;
              if ('parentSessionId' in meta) existing.parentSessionId = meta.parentSessionId;
              if ('worktreeId' in meta) existing.worktreeId = (meta as any).worktreeId;
              if ('hostDeviceId' in meta) existing.hostDeviceId = meta.hostDeviceId;
              if ('isArchived' in meta) existing.isArchived = meta.isArchived;
              if ('isPinned' in meta) existing.isPinned = (meta as any).isPinned;
              if ('queuedPrompts' in meta) existing.queuedPrompts = meta.queuedPrompts;
              if ('currentContext' in meta) existing.currentContext = meta.currentContext;
              if ('hasPendingPrompt' in meta) existing.hasPendingPrompt = meta.hasPendingPrompt;
              if ('phase' in meta) (existing as any).phase = (meta as any).phase;
              if ('tags' in meta) (existing as any).tags = (meta as any).tags;
              if ('lastReadAt' in meta) (existing as any).lastReadAt = (meta as any).lastReadAt;
              if ('draftInput' in meta) (existing as any).draftInput = (meta as any).draftInput;
              if ('draftUpdatedAt' in meta) (existing as any).draftUpdatedAt = (meta as any).draftUpdatedAt;
              if ('hasBeenNamed' in meta) (existing as any).hasBeenNamed = (meta as any).hasBeenNamed;
              if ('updatedAt' in meta) existing.updatedAt = meta.updatedAt;
              pendingMetadataUpdates.set(sessionId, existing);
            } else {
              // console.log('[CollabV3] Skipping index update - no cached data and missing required fields for session:', sessionId);
            }
          }
        }
      }

      return sessionRoomOutcome ?? { published: true };
    },

    syncSessionsToIndex(sessionsData: SessionIndexData[], options?: {
      syncMessages?: boolean;
      messageSyncRequests?: Array<{ sessionId: string; sinceTimestamp: number }>;
      getMessagesForSync?: (requests: Array<{ sessionId: string; sinceTimestamp: number }>) => Promise<Map<string, any[]>>;
    }): void {
      const syncableSessions = filterSessionsForPersonalSync(sessionsData);
      if (syncableSessions.length === 0) {
        return;
      }

      const syncableSessionIds = new Set(
        syncableSessions.map((session) => session.id)
      );
      const syncableOptions = options
        ? {
            ...options,
            messageSyncRequests: options.messageSyncRequests?.filter(
              (request) => syncableSessionIds.has(request.sessionId)
            ),
          }
        : undefined;

      if (!indexWs || !indexConnected) {
        // Queue the operation to run when connection is established
        console.log('[CollabV3] Index not connected yet, queueing sync of', syncableSessions.length, 'sessions');
        pendingOperations.push({
          type: 'sessions',
          data: syncableSessions,
          options: syncableOptions,
        });
        return;
      }

      // console.log('[CollabV3] syncSessionsToIndex called with', sessionsData.length, 'sessions, ids:', sessionsData.map(s => s.id).join(', '));

      // Call the helper function
      // Note: async but this method returns void for backwards compatibility
      doSyncSessionsToIndex(syncableSessions, syncableOptions).catch(err => {
        console.error('[CollabV3] Error in doSyncSessionsToIndex:', err);
      });
    },

    syncProjectsToIndex(projects: ProjectIndexEntry[]): void {
      // Projects are derived from sessions in CollabV3
      // The index room calculates project stats from session data
      // console.log('[CollabV3] Projects are auto-calculated from sessions');
    },

    async syncProjectConfig(projectId: string, projectConfig: ProjectConfig): Promise<void> {
      if (!indexWs || !indexConnected) {
        console.log('[CollabV3] Index not connected, cannot sync project config');
        return;
      }
      if (!config.encryptionKey) {
        console.error('[CollabV3] Cannot sync project config: no encryption key');
        return;
      }
      if (withholdPersonalSyncWrite('project config publish')) return;

      // Encrypt project ID (deterministic)
      const { encryptedProjectId, projectIdIv } = await encryptProjectId(projectId, config.encryptionKey);

      // Build message -- only include the encrypted config when it carries
      // content, so a hash-only call doesn't overwrite existing config with an
      // empty object. This deliberately checks actions as well as commands: an
      // actions-only workspace used to publish nothing at all, which was
      // invisible on any repo that happened to have slash commands.
      const message: Record<string, unknown> = {
        type: 'projectConfigUpdate',
        encryptedProjectId,
        projectIdIv,
        gitRemoteHash: projectConfig.gitRemoteHash,
      };

      if (hasPublishableConfig(projectConfig)) {
        const configJson = JSON.stringify(projectConfig);
        const { encrypted: encryptedConfig, iv: configIv } = await encrypt(configJson, config.encryptionKey);
        message.encryptedConfig = encryptedConfig;
        message.configIv = configIv;
      }

      indexWs.send(JSON.stringify(message));
      // console.log('[CollabV3] Sent projectConfigUpdate with', projectConfig.commands.length, 'commands and', projectConfig.actions?.length ?? 0, 'actions');
    },

    async fetchIndex(): Promise<{ complete?: boolean; indexProtocolVersion?: 1 | 2; deletedSessionIds?: string[]; sessions: DecryptedSessionIndexEntry[]; projects: Array<{ projectId: string; name: string; sessionCount: number; lastActivityAt: number; syncEnabled: boolean; gitRemoteHash?: string }> }> {
      // Wait for connection if not ready
      if (!indexWs || !indexConnected) {
        // console.log('[CollabV3] Waiting for index connection before fetching...');
        await new Promise<void>((resolve) => {
          const checkConnection = setInterval(() => {
            if (indexWs && indexConnected) {
              clearInterval(checkConnection);
              resolve();
            }
          }, 100);
          // Timeout after 10 seconds
          setTimeout(() => {
            clearInterval(checkConnection);
            resolve();
          }, 10000);
        });
      }

      if (!indexWs || !indexConnected) {
        throw new Error('Index connection not available');
      }

      if (indexProtocolCapability !== 'legacy') {
        try {
          await indexDrainQueue.run('index', () => runIndexReplicationWithPersonalState({ notifyListeners: false }));
          // `snapshot()` throws unless coverage is complete. Callers use absence
          // from this result as "the server is missing it, republish", so a
          // partial mirror must fail the fetch instead of being returned.
          const { sessions, projects } = indexMirror.snapshot();
          // Every row in a complete mirror decrypted under this key.
          personalSyncWriteGate.markVerified();
          return {
            complete: true,
            indexProtocolVersion: 2,
            // Explicit server tombstones, retained across a full rebuild. The
            // caller must NOT republish these: absent-and-tombstoned is a
            // deletion, absent-and-unknown is something the server never got.
            deletedSessionIds: indexMirror.deletedIds('session'),
            sessions,
            projects,
          };
        } catch (err) {
          if (err instanceof IndexEntryDecryptionError) {
            personalSyncWriteGate.markBlocked('decryption-failed', err.message);
          }
          if (!(err instanceof IndexProtocolUnsupportedError)) {
            // A real failure (transport, timeout, partial bootstrap) is NOT a
            // reason to fall back: the legacy path would answer with a complete
            // snapshot we have no right to claim.
            throw err;
          }
          indexProtocolCapability = 'legacy';
          console.warn('[CollabV3] Index server does not support the v2 paged protocol; using the legacy full index. Bounded index transport is NOT active on this connection.');
        }
      }

      return new Promise((resolve, reject) => {
        // Set timeout for response
        const timeout = setTimeout(() => {
          if (pendingIndexFetch) {
            pendingIndexFetch = null;
            reject(new Error('Timeout waiting for index response'));
          }
        }, 30000);

        pendingIndexFetch = {
          resolve: (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        };

        // Send index sync request
        const request: ClientMessage = { type: 'indexSyncRequest' };
        indexWs!.send(JSON.stringify(request));
        // console.log('[CollabV3] Sent index_sync_request');
      });
    },

    onIndexChange(callback: (sessionId: string, entry: CachedSessionIndex) => void): () => void {
      indexChangeListeners.add(callback);
      // console.log('[CollabV3] Added index change listener, total:', indexChangeListeners.size);
      return () => {
        indexChangeListeners.delete(callback);
        // console.log('[CollabV3] Removed index change listener, total:', indexChangeListeners.size);
      };
    },

    /** Get cached metadata for a session (from sync_response and metadata_broadcast) */
    getCachedMetadata(sessionId: string): Partial<SessionMetadata> | undefined {
      const session = sessions.get(sessionId);
      return session?.cachedMetadata;
    },

    /** Get cached index entry for a session (from index_sync_response and index_broadcast) */
    getCachedIndexEntry(sessionId: string): CachedSessionIndex | undefined {
      return sessionIndexCache.get(sessionId);
    },

    /** Clear isExecuting in all cached index entries (for startup cleanup) */
    clearAllExecutingState(): void {
      for (const [, entry] of sessionIndexCache) {
        if (entry.isExecuting) {
          entry.isExecuting = false;
        }
      }
      // Also clear any pending metadata updates that have isExecuting set
      for (const [, pending] of pendingMetadataUpdates) {
        if ('isExecuting' in pending) {
          pending.isExecuting = false;
        }
      }
    },

    /** Subscribe to session creation requests from other devices (e.g., mobile) */
    onCreateSessionRequest(callback: (request: CreateSessionRequest) => void): () => void {
      createSessionRequestListeners.add(callback);
      return () => {
        createSessionRequestListeners.delete(callback);
      };
    },

    /** Send a response to a session creation request */
    async sendCreateSessionResponse(response: CreateSessionResponse): Promise<void> {
      // Ensure we're connected before sending the response
      if (!indexWs || !indexConnected) {
        console.log('[CollabV3] Not connected to index, attempting to reconnect before sending create session response...');
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect to index before sending create session response:', err);
          return;
        }
      }

      // Double-check connection after await
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot send create session response - failed to establish connection');
        return;
      }

      const wireResponse: EncryptedCreateSessionResponse = {
        requestId: response.requestId,
        success: response.success,
        sessionId: response.sessionId,
        error: response.error,
      };

      const msg: ClientMessage = { type: 'createSessionResponse', response: wireResponse };
      console.log('[CollabV3] Sending create_session_response:', response.requestId, 'success:', response.success, 'sessionId:', response.sessionId);
      indexWs.send(JSON.stringify(msg));
    },

    /** Send a session creation request (for mobile to request desktop to create a session) */
    async sendCreateSessionRequest(request: CreateSessionRequest): Promise<void> {
      // Ensure we're connected before sending the request
      if (!indexWs || !indexConnected) {
        console.log('[CollabV3] Not connected to index, attempting to reconnect before sending create session request...');
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect to index before sending create session request:', err);
          return;
        }
      }

      // Double-check connection after await
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot send create session request - failed to establish connection');
        return;
      }

      // Encryption is required
      if (!config.encryptionKey) {
        console.error('[CollabV3] Cannot send create session request - no encryption key');
        return;
      }

      // Encrypt projectId
      const { encryptedProjectId, projectIdIv } = await encryptProjectId(request.projectId, config.encryptionKey);

      const wireRequest: EncryptedCreateSessionRequest = {
        requestId: request.requestId,
        encryptedProjectId,
        projectIdIv,
        sessionType: request.sessionType,
        parentSessionId: request.parentSessionId,
        provider: request.provider,
        model: request.model,
        agentRole: request.agentRole,
        timestamp: request.timestamp,
      };

      // Encrypt initial prompt if present
      if (request.initialPrompt) {
        try {
          const { encrypted, iv } = await encrypt(request.initialPrompt, config.encryptionKey);
          wireRequest.encryptedInitialPrompt = encrypted;
          wireRequest.initialPromptIv = iv;
        } catch (err) {
          console.error('[CollabV3] Failed to encrypt initial prompt:', err);
        }
      }

      const msg: ClientMessage = {
        type: 'createSessionRequest',
        request: wireRequest,
        targetDeviceId: request.targetDeviceId,
      };
      // Debug logging - uncomment if needed
      // console.log('[CollabV3] Sending create_session_request:', request.requestId, 'project:', request.projectId);
      indexWs.send(JSON.stringify(msg));
    },

    /** Subscribe to session creation responses (for mobile to receive response from desktop) */
    onCreateSessionResponse(callback: (response: CreateSessionResponse) => void): () => void {
      createSessionResponseListeners.add(callback);
      return () => {
        createSessionResponseListeners.delete(callback);
      };
    },

    /** Subscribe to voice-tool requests from other devices (desktop runs the tool). */
    onVoiceToolRequest(callback: (request: VoiceToolRequest) => void): () => void {
      voiceToolRequestListeners.add(callback);
      return () => {
        voiceToolRequestListeners.delete(callback);
      };
    },

    /** Send a voice-tool result back to the requesting device (desktop -> mobile). */
    async sendVoiceToolResponse(response: VoiceToolResponse): Promise<void> {
      if (!indexWs || !indexConnected) {
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect before sending voice tool response:', err);
          return;
        }
      }
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot send voice tool response - not connected');
        return;
      }
      if (!config.encryptionKey) {
        console.error('[CollabV3] Cannot send voice tool response - no encryption key');
        return;
      }

      const wireResponse: EncryptedVoiceToolResponse = {
        requestId: response.requestId,
        success: response.success,
      };
      try {
        if (response.resultJson) {
          const { encrypted, iv } = await encrypt(response.resultJson, config.encryptionKey);
          wireResponse.encryptedResult = encrypted;
          wireResponse.resultIv = iv;
        }
        if (response.error) {
          const { encrypted, iv } = await encrypt(response.error, config.encryptionKey);
          wireResponse.encryptedError = encrypted;
          wireResponse.errorIv = iv;
        }
      } catch (err) {
        console.error('[CollabV3] Failed to encrypt voice tool response:', err);
        return;
      }

      const msg: ClientMessage = { type: 'voiceToolResponse', response: wireResponse };
      indexWs.send(JSON.stringify(msg));
    },

    /** Send a voice-tool request (mobile -> desktop). */
    async sendVoiceToolRequest(request: VoiceToolRequest): Promise<void> {
      if (!indexWs || !indexConnected) {
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect before sending voice tool request:', err);
          return;
        }
      }
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot send voice tool request - not connected');
        return;
      }
      if (!config.encryptionKey) {
        console.error('[CollabV3] Cannot send voice tool request - no encryption key');
        return;
      }

      const { encryptedProjectId, projectIdIv } = await encryptProjectId(request.projectId, config.encryptionKey);
      const toolNameEnc = await encrypt(request.toolName, config.encryptionKey);
      const argsEnc = await encrypt(request.argsJson, config.encryptionKey);

      const wireRequest: EncryptedVoiceToolRequest = {
        requestId: request.requestId,
        encryptedProjectId,
        projectIdIv,
        encryptedToolName: toolNameEnc.encrypted,
        toolNameIv: toolNameEnc.iv,
        encryptedArgs: argsEnc.encrypted,
        argsIv: argsEnc.iv,
        timestamp: request.timestamp,
      };

      const msg: ClientMessage = { type: 'voiceToolRequest', request: wireRequest };
      indexWs.send(JSON.stringify(msg));
    },

    /** Subscribe to voice-tool responses (mobile receives the desktop result). */
    onVoiceToolResponse(callback: (response: VoiceToolResponse) => void): () => void {
      voiceToolResponseListeners.add(callback);
      return () => {
        voiceToolResponseListeners.delete(callback);
      };
    },

    /** Subscribe to worktree creation requests from other devices (e.g., mobile) */
    onCreateWorktreeRequest(callback: (request: CreateWorktreeRequest) => void): () => void {
      createWorktreeRequestListeners.add(callback);
      return () => {
        createWorktreeRequestListeners.delete(callback);
      };
    },

    /** Send a response to a worktree creation request */
    async sendCreateWorktreeResponse(response: CreateWorktreeResponse): Promise<void> {
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot send create worktree response - not connected');
        return;
      }

      const wireResponse: EncryptedCreateWorktreeResponse = {
        requestId: response.requestId,
        success: response.success,
        error: response.error,
      };

      const msg: ClientMessage = { type: 'createWorktreeResponse', response: wireResponse };
      console.log('[CollabV3] Sending createWorktreeResponse:', response.requestId, 'success:', response.success);
      indexWs.send(JSON.stringify(msg));
    },

    /** Get list of currently connected devices */
    getConnectedDevices(): DeviceInfo[] {
      return Array.from(connectedDevices.values());
    },

    /** Get this client's own current device identity. */
    getLocalDeviceInfo(): DeviceInfo | undefined {
      return localDeviceInfo();
    },

    /** Subscribe to device status changes (devices joining/leaving) */
    onDeviceStatusChange(callback: (devices: DeviceInfo[]) => void): () => void {
      deviceStatusListeners.add(callback);
      console.log('[CollabV3] Device status listener registered, total:', deviceStatusListeners.size);
      // Immediately notify with current state
      const currentDevices = Array.from(connectedDevices.values());
      console.log('[CollabV3] Immediately notifying with', currentDevices.length, 'devices');
      callback(currentDevices);
      return () => {
        deviceStatusListeners.delete(callback);
        console.log('[CollabV3] Device status listener unregistered, total:', deviceStatusListeners.size);
      };
    },

    /** Send a generic session control message (cross-device via IndexRoom) */
    async sendSessionControlMessage(message: SessionControlMessage): Promise<void> {
      // Ensure we're connected before sending the message
      if (!indexWs || !indexConnected) {
        console.log('[CollabV3] Not connected to index, attempting to reconnect before sending session control message...');
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect to index before sending session control message:', err);
          return;
        }
      }

      // Double-check connection after await
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot send session control message - failed to establish connection');
        return;
      }

      const msg: ClientMessage = {
        type: 'sessionControl',
        message: {
          sessionId: message.sessionId,
          messageType: message.type,
          payload: message.payload,
          timestamp: message.timestamp,
          sentBy: message.sentBy,
          sentByDeviceId: message.sentByDeviceId ?? localDeviceId(),
          targetDeviceId: message.targetDeviceId,
        },
      };
      console.log('[CollabV3] Sending sessionControl:', message.sessionId, message.type);
      indexWs.send(JSON.stringify(msg));
    },

    /** Subscribe to session control messages from other devices */
    onSessionControlMessage(callback: (message: SessionControlMessage) => void): () => void {
      sessionControlMessageListeners.add(callback);
      return () => {
        sessionControlMessageListeners.delete(callback);
      };
    },

    /** Sync settings to other devices (encrypted via index room) */
    async syncSettings(settings: SyncedSettings): Promise<void> {
      // Ensure we're connected before sending
      if (!indexWs || !indexConnected) {
        console.log('[CollabV3] Not connected to index, attempting to reconnect before syncing settings...');
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect to index before syncing settings:', err);
          return;
        }
      }

      // Double-check connection after await
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot sync settings - failed to establish connection');
        return;
      }

      // Encryption is required
      if (!config.encryptionKey) {
        console.error('[CollabV3] Cannot sync settings - no encryption key');
        return;
      }

      try {
        // Get our device ID
        const deviceId = localDeviceId() ?? 'unknown';

        // Encrypt the settings as JSON
        const settingsJson = JSON.stringify(settings);
        const { encrypted, iv } = await encrypt(settingsJson, config.encryptionKey);

        const payload: EncryptedSettingsPayload = {
          encryptedSettings: encrypted,
          settingsIv: iv,
          deviceId: deviceId,
          timestamp: Date.now(),
          version: settings.version,
        };

        const msg: ClientMessage = { type: 'settingsSync', settings: payload };
        // console.log('[CollabV3] Syncing settings, version:', settings.version, 'ws state:', indexWs.readyState);
        if (indexWs.readyState !== WS_OPEN) {
          console.error('[CollabV3] Cannot sync settings - websocket not open, state:', indexWs.readyState);
          return;
        }
        indexWs.send(JSON.stringify(msg));
        // console.log('[CollabV3] Settings sync message sent successfully');
      } catch (err) {
        console.error('[CollabV3] Failed to encrypt/send settings:', err);
      }
    },

    /** Subscribe to settings sync events from other devices */
    onSettingsSync(callback: (settings: SyncedSettings) => void): () => void {
      settingsSyncListeners.add(callback);
      return () => {
        settingsSyncListeners.delete(callback);
      };
    },

    /** Push a personal read receipt to the user's other devices. */
    async syncReadReceipt(receipt: SyncedReadReceipt): Promise<void> {
      if (!indexWs || !indexConnected) {
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect to index before syncing read receipt:', err);
          return;
        }
      }
      if (!indexWs || !indexConnected || indexWs.readyState !== WS_OPEN) {
        return;
      }
      if (!config.encryptionKey) {
        console.error('[CollabV3] Cannot sync read receipt - no encryption key');
        return;
      }
      try {
        const deviceId = localDeviceId() ?? 'unknown';
        const receiptKey = await sha256Hex(
          `${receipt.entityKind}|${receipt.entityId}|${receipt.scope}`,
        );
        const { encrypted, iv } = await encrypt(JSON.stringify(receipt), config.encryptionKey);
        const payload: EncryptedReadReceiptPayload = {
          receiptKey,
          encryptedReceipt: encrypted,
          receiptIv: iv,
          deviceId,
          version: receipt.lastViewedAt,
          timestamp: Date.now(),
        };
        const msg: ClientMessage = { type: 'readReceipt', receipt: payload };
        indexWs.send(JSON.stringify(msg));
      } catch (err) {
        console.error('[CollabV3] Failed to encrypt/send read receipt:', err);
      }
    },

    /** Subscribe to read receipts arriving from the user's other devices. */
    onReadReceipt(callback: (receipt: SyncedReadReceipt) => void): () => void {
      readReceiptListeners.add(callback);
      return () => {
        readReceiptListeners.delete(callback);
      };
    },

    async syncTrackerPersonalState(change: SyncedTrackerPersonalStateChange): Promise<void> {
      if (!indexWs || !indexConnected) {
        try { await connectToIndex(); }
        catch (err) {
          console.error('[CollabV3] Failed to connect before syncing tracker personal state:', err);
          return;
        }
      }
      if (!indexWs || !indexConnected || indexWs.readyState !== WS_OPEN) return;
      if (!config.encryptionKey) {
        console.error('[CollabV3] Cannot sync tracker personal state - no encryption key');
        return;
      }
      try {
        const deviceId = localDeviceId() ?? 'unknown';
        const stateKey = await deriveTrackerPersonalStateKey(change.scope, change.itemId, change.kind);
        const { encrypted, iv } = await encrypt(JSON.stringify(change), config.encryptionKey);
        const version = change.kind === 'favorite' ? change.favoriteUpdatedAt : change.lastOpenedAt;
        const state: EncryptedTrackerPersonalStatePayload = {
          stateKey,
          encryptedState: encrypted,
          stateIv: iv,
          deviceId,
          version,
          timestamp: Date.now(),
        };
        indexWs.send(JSON.stringify({ type: 'trackerPersonalState', state } satisfies ClientMessage));
      } catch (err) {
        console.error('[CollabV3] Failed to encrypt/send tracker personal state:', err);
      }
    },

    onTrackerPersonalState(callback: (change: SyncedTrackerPersonalStateChange) => void): () => void {
      trackerPersonalStateListeners.add(callback);
      return () => trackerPersonalStateListeners.delete(callback);
    },

    /**
     * Push the ambient fleet snapshot to the user's Live Activity.
     *
     * Unlike `requestMobilePush` this does not reconnect on demand. The lane is
     * ambient and coalesced, so a disconnected desktop simply misses an update
     * and the phone's stale date says so -- forcing a reconnect for a card that
     * nobody may be looking at would be the more expensive mistake, and the next
     * transition after reconnect carries the full current state anyway.
     */
    async sendFleetActivity(activity: FleetActivitySnapshot, shownOnDesktop = false): Promise<void> {
      if (!indexWs || !indexConnected || indexWs.readyState !== WS_OPEN) return;
      const msg: ClientMessage = { type: 'fleetActivityUpdate', activity, shownOnDesktop };
      try {
        indexWs.send(JSON.stringify(msg));
      } catch (error) {
        console.warn('[CollabV3] Failed to send fleet activity update:', error);
      }
    },

    /** Request the sync server to send a push notification to mobile devices */
    async requestMobilePush(
      sessionId: string,
      title: string,
      body: string,
      options?: MobilePushOptions
    ): Promise<MobilePushResult> {
      const failed = (rejection: PushRejectionCause): MobilePushResult => ({
        accepted: false,
        attemptedCount: 0,
        deliveredCount: 0,
        skipped: [],
        rejection,
      });

      // Ensure we're connected before sending the request
      if (!indexWs || !indexConnected) {
        console.log('[CollabV3] Not connected to index, attempting to reconnect before requesting mobile push...');
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect to index before requesting mobile push:', err);
          return failed('no_ack');
        }
      }

      // Double-check connection and WebSocket state after await
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot request mobile push - failed to establish connection');
        return failed('no_ack');
      }

      // Check actual WebSocket state
      if (indexWs.readyState !== WS_OPEN) {
        console.error('[CollabV3] Cannot request mobile push - WebSocket not open, state:', indexWs.readyState);
        return failed('no_ack');
      }

      const deviceId = localDeviceId();
      const requestId = `push-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const msg: ClientMessage = {
        type: 'requestMobilePush',
        sessionId: sessionId,
        title,
        body,
        requestingDeviceId: deviceId,
        requestId,
        force: options?.force === true,
        reason: options?.reason,
      };
      // console.log('[CollabV3] Requesting mobile push for session:', sessionId, 'deviceId:', deviceId, 'readyState:', indexWs.readyState);

      const ack = new Promise<MobilePushResult>((resolve) => {
        // A server that never answers must not leave the caller hanging -- and
        // a silent timeout is itself the signal that something is wrong, which
        // is exactly what this path used to lack.
        const timer = setTimeout(() => {
          pendingMobilePushes.delete(requestId);
          console.warn('[CollabV3] No mobile push acknowledgement for request:', requestId);
          resolve(failed('no_ack'));
        }, MOBILE_PUSH_ACK_TIMEOUT_MS);
        pendingMobilePushes.set(requestId, { resolve, timer });
      });

      try {
        indexWs.send(JSON.stringify(msg));
        // console.log('[CollabV3] Mobile push message sent successfully');
      } catch (error) {
        console.error('[CollabV3] Failed to send mobile push message:', error);
        const pending = pendingMobilePushes.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingMobilePushes.delete(requestId);
        }
        return failed('no_ack');
      }

      return ack;
    },

    syncFileToIndex(file: FileIndexData): void {
      if (!indexWs || !indexConnected || !config.encryptionKey) return;

      (async () => {
        try {
          const key = config.encryptionKey!;
          const { encryptedProjectId, projectIdIv } = await encryptProjectId(file.projectId, key);
          const { encrypted: encryptedRelativePath, iv: relativePathIv } = await encrypt(file.relativePath, key);
          const { encrypted: encryptedTitle, iv: titleIv } = await encrypt(file.title, key);

          const msg: ClientMessage = {
            type: 'fileIndexUpdate',
            file: {
              docId: file.docId,
              encryptedProjectId,
              projectIdIv,
              encryptedRelativePath,
              relativePathIv,
              encryptedTitle,
              titleIv,
              lastModifiedAt: file.lastModifiedAt,
              syncedAt: Date.now(),
            },
          };
          indexWs!.send(JSON.stringify(msg));
        } catch (err) {
          console.error('[CollabV3] Failed to sync file to index:', err);
        }
      })();
    },

    deleteFileFromIndex(docId: string): void {
      if (!indexWs || !indexConnected) return;
      const msg: ClientMessage = { type: 'fileIndexDelete', docId };
      indexWs.send(JSON.stringify(msg));
    },

    /** Attempt to reconnect the index connection when network becomes available */
    async reconnectIndex(): Promise<void> {
      // A previous reconnectIndex() already started a fresh handshake that
      // hasn't resolved yet. Don't tear it down -- post-wake the broker fires
      // several network-available events in a ~20s burst and we'd otherwise
      // churn through half-finished sockets.
      if (indexWs && !indexConnected && indexWs.readyState === WS_CONNECTING) {
        console.log('[CollabV3] reconnectIndex() - handshake already in flight, skipping');
        return;
      }

      // Cancel any pending backoff reconnect - this is an explicit reconnect request
      // (e.g. from network change / resume) that should take priority
      if (indexReconnectTimer) {
        clearTimeout(indexReconnectTimer);
        indexReconnectTimer = null;
      }
      indexReconnectAttempts = 0;
      indexPreOpenFailures = 0;
      // Explicit reconnect = user/system signal that something changed (network,
      // settings, auth refresh). Clear the auth-blocked latch and give the JWT
      // another shot. If it still mismatches, ensureFreshJwt will set the flag
      // again immediately and we won't enter another tight loop.
      indexAuthBlocked = false;

      // Force-close the current socket, even if it still reports OPEN.
      // After laptop sleep the WebSocket layer can stay "connected" while the
      // underlying transport is dead. This explicit reconnect path exists to
      // recover from exactly that half-open state.
      if (indexWs) {
        console.log('[CollabV3] reconnectIndex() - forcing fresh index socket (readyState:', indexWs.readyState, ')');
        try {
          indexWs.onclose = null;
          indexWs.onerror = null;
          indexWs.close();
        } catch (_) {
          /* ignore close errors */
        }
        indexWs = null;
      }
      indexConnected = false;
      indexPublicationGate.reset();
      indexConnectionGeneration++;
      indexProtocolCapability = 'unknown';
      cancelPendingIndexPage('Index reconnect requested while a page request was in flight');
      maxHintedRevision = undefined;
      hintDrainScheduled = false;
      cancelPendingPersonalStatePage('Index reconnect requested while a personal state page was in flight');
      clearIndexReady();
      stopPingInterval();
      stopDeviceAnnounceInterval();

      console.log('[CollabV3] Network available, attempting to reconnect index...');
      try {
        await connectToIndex();
        console.log('[CollabV3] Successfully reconnected to index after network restoration');
      } catch (err) {
        console.error('[CollabV3] Failed to reconnect to index:', err);
        // Start the backoff retry loop since the explicit reconnect failed
        scheduleIndexReconnect();
      }
    },

    /**
     * Returns true if the index is currently past its post-open stability window
     * and considered usable for fan-out to other sync providers.
     */
    isIndexReady(): boolean {
      return indexReady;
    },

    /**
     * The index socket's identity, as a counter bumped on every disconnect (see
     * `indexConnectionGeneration`). A caller holding a claim the server bound to
     * one socket -- a create-session request -- compares this before answering:
     * unlike `isIndexReady()`, a full down-and-up cycle cannot hide inside it.
     */
    getConnectionGeneration(): number {
      return indexConnectionGeneration;
    },

    /**
     * Called every time the index socket becomes usable, with the generation
     * then in force. Returns an unsubscribe.
     */
    onConnectionGenerationChange(callback: (generation: number) => void): () => void {
      connectionGenerationListeners.add(callback);
      return () => connectionGenerationListeners.delete(callback);
    },

    /** Whether this device may publish personal-sync ciphertext. See GitHub #1117. */
    getPersonalSyncWriteGate(): PersonalSyncWriteGateSnapshot {
      return personalSyncWriteGate.snapshot();
    },

    onPersonalSyncWriteGateChange(callback: (snapshot: PersonalSyncWriteGateSnapshot) => void): () => void {
      return personalSyncWriteGate.onChange(callback);
    },

    /**
     * Wait for the index to reach the `ready` state (open + stable). Resolves
     * immediately if already ready. Rejects after `timeoutMs` otherwise.
     *
     * Used by SyncManager.attemptReconnect to gate cascading reconnects of
     * TrackerSync, TeamSync, and DocumentSync on a verified-healthy index.
     */
    waitForIndexReady(timeoutMs: number = 5000): Promise<void> {
      if (indexReady) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          indexReadyListeners.delete(listener);
          reject(new Error(`Index not ready within ${timeoutMs}ms`));
        }, timeoutMs);
        const listener = () => {
          clearTimeout(timer);
          resolve();
        };
        indexReadyListeners.add(listener);
      });
    },
  };

  return provider;
}
