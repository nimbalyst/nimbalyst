/**
 * CollabV3 Sync Provider
 *
 * Provides real-time sync of AI sessions using the CollabV3 protocol.
 * Uses WebSocket connections to Durable Objects with DO SQLite storage.
 *
 * Authentication:
 * - Uses Stytch session JWTs for all WebSocket connections
 * - User ID is extracted from the JWT 'sub' claim
 * - JWT is sent in the Authorization header (with protocol workaround for WebSocket)
 *
 * Key differences from Y.js sync (CollabV2):
 * - Simple append-only message protocol (no CRDTs)
 * - Cursor-based pagination instead of state vectors
 * - Per-message encryption instead of whole-doc encryption
 * - No tombstone bloat from deletions
 */

import type { AgentMessage } from '../ai/server/types';
import { shouldSyncMessageForSessionRoom, truncateContentForSync } from './syncContentTruncator';
import { appendSyncClientParams } from './syncClientInfo';
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
  EncryptedSettingsPayload,
  SyncedSettings,
  SessionControlMessage,
  EncryptedAttachment,
  FileIndexData,
  SyncedAgentStatus,
} from './types';

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
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  isExecuting?: boolean;
  /** Number of prompts queued from mobile, waiting for desktop to process */
  queuedPromptCount?: number;
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
  messageCount: number;
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
type DecryptedSessionIndexEntry = Omit<SessionIndexEntry, 'title' | 'encryptedTitle' | 'titleIv' | 'encryptedProjectId' | 'projectIdIv' | 'encryptedQueuedPrompts' | 'encryptedClientMetadata' | 'clientMetadataIv'> & {
  title: string;  // Required after decryption
  projectId: string;  // Decrypted project ID
  queuedPrompts?: PlaintextQueuedPrompt[];  // Decrypted queued prompts
  currentContext?: { tokens: number; contextWindow: number };  // Decrypted from client metadata
  agentStatus?: SyncedAgentStatus | null;  // Decrypted from client metadata
  hasBeenNamed?: boolean;  // Decrypted from client metadata
  mobileTranscriptTailJson?: string;  // Decrypted from client metadata
  mobileTranscriptTailUpdatedAt?: number;  // Decrypted from client metadata
  mobileTranscriptHistoryPageJson?: string;  // Decrypted from client metadata
  mobileTranscriptHistoryPageUpdatedAt?: number;  // Decrypted from client metadata
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
  | { type: 'createSessionRequest'; request: EncryptedCreateSessionRequest }
  | { type: 'createSessionResponse'; response: EncryptedCreateSessionResponse }
  | { type: 'createWorktreeRequest'; request: EncryptedCreateWorktreeRequest }
  | { type: 'createWorktreeResponse'; response: EncryptedCreateWorktreeResponse }
  | { type: 'sessionControl'; message: { sessionId: string; messageType: string; payload?: Record<string, unknown>; timestamp: number; sentBy: 'desktop' | 'mobile' } }
  | { type: 'requestMobilePush'; sessionId: string; title: string; body: string; requestingDeviceId?: string }
  | { type: 'settingsSync'; settings: EncryptedSettingsPayload }
  | { type: 'fileIndexUpdate'; file: EncryptedFileIndexEntry }
  | { type: 'fileIndexDelete'; docId: string };

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
  | { type: 'syncResponse'; messages: EncryptedMessage[]; metadata: SessionMetadata | null; hasMore: boolean; cursor: string | null }
  | { type: 'messageBroadcast'; message: EncryptedMessage; fromConnectionId?: string }
  | { type: 'metadataBroadcast'; metadata: Partial<SessionMetadata>; fromConnectionId?: string }
  | { type: 'indexSyncResponse'; sessions: SessionIndexEntry[]; projects: ServerProjectEntry[] }
  | { type: 'indexBroadcast'; session: SessionIndexEntry; fromConnectionId?: string }
  | { type: 'projectBroadcast'; project: ServerProjectEntry; fromConnectionId?: string }
  | { type: 'devicesList'; devices: DeviceInfo[] }
  | { type: 'deviceJoined'; device: DeviceInfo }
  | { type: 'deviceLeft'; deviceId: string }
  | { type: 'createSessionRequestBroadcast'; request: EncryptedCreateSessionRequest; fromConnectionId?: string }
  | { type: 'createSessionResponseBroadcast'; response: EncryptedCreateSessionResponse; fromConnectionId?: string }
  | { type: 'createWorktreeRequestBroadcast'; request: EncryptedCreateWorktreeRequest; fromConnectionId?: string }
  | { type: 'createWorktreeResponseBroadcast'; response: EncryptedCreateWorktreeResponse; fromConnectionId?: string }
  | { type: 'sessionControlBroadcast'; message: { sessionId: string; messageType: string; payload?: Record<string, unknown>; timestamp: number; sentBy: 'desktop' | 'mobile' }; fromConnectionId?: string }
  | { type: 'settingsSyncBroadcast'; settings: EncryptedSettingsPayload; fromConnectionId?: string }
  | { type: 'error'; code: string; message: string };

// ============================================================================
// JWT Utilities
// ============================================================================

interface JwtClaims {
  sub: string;
  /** Stytch B2B organization_id claim. Personal-scoped JWTs carry the personal orgId; team-scoped JWTs carry the team orgId. */
  organization_id?: string;
}

/**
 * Decode a JWT's payload claims. Does not verify the signature -- the server does that.
 * The JWT is a base64url encoded string in the format: header.payload.signature
 */
function decodeJwtClaims(jwt: string): JwtClaims {
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
  /** Compact live status for cross-device session UI. */
  agentStatus?: SyncedAgentStatus | null;
  /** Kanban phase: backlog, planning, implementing, validating, complete */
  phase?: string;
  /** Arbitrary tags for categorization */
  tags?: string[];
  /** Legacy remote draft field. Do not publish new values. */
  draftInput?: string;
  /** Legacy remote draft field. Do not publish new values. */
  draftUpdatedAt?: number;
  /** Marker that the title was AI-chosen; prevents repeated rename attempts. */
  hasBeenNamed?: boolean;
  /** Compact projected transcript tail for oversized sessions on mobile. */
  mobileTranscriptTailJson?: string;
  /** Freshness marker for the mobile transcript tail. */
  mobileTranscriptTailUpdatedAt?: number;
  /** Latest cursor-based projected history page requested by mobile. */
  mobileTranscriptHistoryPageJson?: string;
  /** Freshness marker for the latest mobile history page. */
  mobileTranscriptHistoryPageUpdatedAt?: number;
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
  const hasBeenNamed = options.hasBeenNamed;
  const mobileTranscriptTailJson = metadata?.mobileTranscriptTailJson as string | undefined;
  const mobileTranscriptTailUpdatedAt = metadata?.mobileTranscriptTailUpdatedAt as number | undefined;
  const mobileTranscriptHistoryPageJson = metadata?.mobileTranscriptHistoryPageJson as string | undefined;
  const mobileTranscriptHistoryPageUpdatedAt = metadata?.mobileTranscriptHistoryPageUpdatedAt as number | undefined;
  const agentStatus = metadata?.agentStatus as SyncedAgentStatus | null | undefined;
  const hasTokenUsage = tokenUsage?.totalTokens && tokenUsage?.contextWindow;
  const hasPhaseOrTags = phase || (tags && tags.length > 0);
  const hasNamingMarker = hasBeenNamed !== undefined;
  const hasMobileTranscriptTail = mobileTranscriptTailJson !== undefined;
  const hasMobileTranscriptHistoryPage = mobileTranscriptHistoryPageJson !== undefined;
  const hasAgentStatus = agentStatus !== undefined;

  if (!hasTokenUsage && !hasPhaseOrTags && !hasNamingMarker && !hasMobileTranscriptTail && !hasMobileTranscriptHistoryPage && !hasAgentStatus) return undefined;

  const result: ClientMetadata = {};
  if (hasTokenUsage) {
    result.currentContext = {
      tokens: tokenUsage.totalTokens,
      contextWindow: tokenUsage.contextWindow,
    };
  }
  if (phase) result.phase = phase;
  if (tags && tags.length > 0) result.tags = tags;
  if (hasNamingMarker) result.hasBeenNamed = hasBeenNamed;
  if (hasAgentStatus) result.agentStatus = agentStatus;
  if (hasMobileTranscriptTail) result.mobileTranscriptTailJson = mobileTranscriptTailJson;
  if (mobileTranscriptTailUpdatedAt !== undefined) result.mobileTranscriptTailUpdatedAt = mobileTranscriptTailUpdatedAt;
  if (hasMobileTranscriptHistoryPage) result.mobileTranscriptHistoryPageJson = mobileTranscriptHistoryPageJson;
  if (mobileTranscriptHistoryPageUpdatedAt !== undefined) result.mobileTranscriptHistoryPageUpdatedAt = mobileTranscriptHistoryPageUpdatedAt;
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
  'currentContext' | 'hasPendingPrompt' | 'agentStatus' | 'phase' | 'tags' | 'hasBeenNamed' | 'mobileTranscriptTailJson' | 'mobileTranscriptTailUpdatedAt' | 'mobileTranscriptHistoryPageJson' | 'mobileTranscriptHistoryPageUpdatedAt'
>): ClientMetadata | undefined {
  if (
    !entry.currentContext &&
    entry.hasPendingPrompt === undefined &&
    entry.agentStatus === undefined &&
    !entry.phase &&
    !entry.tags &&
    entry.hasBeenNamed === undefined &&
    entry.mobileTranscriptTailJson === undefined &&
    entry.mobileTranscriptHistoryPageJson === undefined
  ) {
    return undefined;
  }

  return {
    currentContext: entry.currentContext,
    hasPendingPrompt: entry.hasPendingPrompt,
    agentStatus: entry.agentStatus,
    phase: entry.phase,
    tags: entry.tags,
    hasBeenNamed: entry.hasBeenNamed,
    mobileTranscriptTailJson: entry.mobileTranscriptTailJson,
    mobileTranscriptTailUpdatedAt: entry.mobileTranscriptTailUpdatedAt,
    mobileTranscriptHistoryPageJson: entry.mobileTranscriptHistoryPageJson,
    mobileTranscriptHistoryPageUpdatedAt: entry.mobileTranscriptHistoryPageUpdatedAt,
  };
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
}

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
  agentStatus?: SyncedAgentStatus | null;
  /** Decrypted queued prompts (stored locally after decryption) */
  queuedPrompts?: PlaintextQueuedPrompt[];
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
  /** Compact projected transcript tail for oversized sessions on mobile. */
  mobileTranscriptTailJson?: string;
  /** Freshness marker for the mobile transcript tail. */
  mobileTranscriptTailUpdatedAt?: number;
  /** Latest cursor-based projected history page requested by mobile. */
  mobileTranscriptHistoryPageJson?: string;
  /** Freshness marker for the latest mobile history page. */
  mobileTranscriptHistoryPageUpdatedAt?: number;
}

// ============================================================================
// CollabV3 Sync Provider
// ============================================================================

export function createCollabV3Sync(config: SyncConfig): SyncProvider {
  // We need to get the initial JWT synchronously for setup, but will refresh before each connection
  // The getJwt function is called before each WebSocket connection to ensure fresh JWT
  let currentJwt: string | null = null;
  let currentUserId: string | null = null;

  // Helper to get fresh JWT and extract user ID.
  // Uses config.userId as the authoritative room routing ID.
  // The JWT sub claim is validated against config.userId -- if they differ,
  // the JWT is from a different org (e.g., team) and the caller's getJwt()
  // should be returning a personal-org-scoped JWT. Log a warning so the
  // mismatch is visible but still use config.userId for routing to ensure
  // desktop and mobile always connect to the same index room.
  async function ensureFreshJwt(): Promise<{ jwt: string; userId: string }> {
    const jwt = await config.getJwt();
    const claims = decodeJwtClaims(jwt);
    const jwtUserId = claims.sub;
    currentJwt = jwt;

    // Use config.userId (personalUserId from SyncManager) as the canonical
    // room routing ID. This must match iOS which also uses the personal
    // member ID. If the JWT sub doesn't match, the server WILL reject the
    // WebSocket auth (it validates JWT sub === room URL userId) -- but
    // routing to the wrong room is worse because it silently breaks
    // cross-device sync (prompts, drafts, etc.).
    if (config.userId && jwtUserId !== config.userId) {
      const jwtIsTeamScoped =
        !!claims.organization_id && !!config.orgId && claims.organization_id !== config.orgId;
      // Rate-limit: this used to log every 2s forever once the loop kicked in.
      const now = Date.now();
      if (now - lastJwtMismatchLogAt > JWT_MISMATCH_LOG_INTERVAL_MS) {
        lastJwtMismatchLogAt = now;
        console.warn(
          '[CollabV3] JWT sub does not match sync config userId -- refusing to connect (would be server-rejected and throttle the client).',
          {
            jwtSub: jwtUserId,
            jwtOrgId: claims.organization_id ?? null,
            configUserId: config.userId, // personalUserId from SyncManager
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
      const err = new Error('CollabV3 JWT/userId mismatch -- connection refused locally to avoid server throttling');
      (err as any).code = 'AUTH_MISMATCH';
      throw err;
    }
    currentUserId = config.userId || jwtUserId;
    return { jwt, userId: currentUserId };
  }

  function isAuthMismatchError(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as any).code === 'AUTH_MISMATCH';
  }

  // Get user ID synchronously if we have a cached JWT, otherwise use config.userId
  function getUserId(): string {
    if (currentUserId) return currentUserId;
    if (config.userId) return config.userId;
    throw new Error('JWT not initialized - call ensureFreshJwt first');
  }

  const sessions = new Map<string, SessionConnection>();
  const sessionIndexCache = new Map<string, CachedSessionIndex>();
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
   * a permanent server-side rejection (e.g. JWT/userId mismatch) used to hammer
   * the server at 2s forever and get us throttled.
   */
  let indexPreOpenFailures = 0;
  let indexReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const disabledMessageSyncSessions = new Set<string>();
  /**
   * When `ensureFreshJwt` detects that the JWT cannot possibly succeed against
   * the configured room (JWT `sub` does not match `config.userId`), we set this
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
  const MOBILE_TRANSCRIPT_TAIL_COUNT = 350;

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
  }

  function isFatalMessageSyncErrorCode(code?: string): boolean {
    return code === 'message_limit_exceeded' || code === 'message_too_large';
  }

  function isMessageSyncDisabled(sessionId: string): boolean {
    return disabledMessageSyncSessions.has(sessionId);
  }

  function disableMessageSync(sessionId: string, code?: string, message?: string): void {
    const firstBlock = !disabledMessageSyncSessions.has(sessionId);
    disabledMessageSyncSessions.add(sessionId);
    if (firstBlock) {
      console.warn(
        `[CollabV3] Disabling message sync for ${sessionId} after fatal server rejection${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`
      );
      void publishMobileTranscriptTail(sessionId);
    }
    updateStatus(sessionId, {
      connected: false,
      syncing: false,
      error: message || 'Session reached the synced-message limit on the server',
    });
    wantedSessions.delete(sessionId);
    const session = sessions.get(sessionId);
    if (session) {
      try {
        session.ws.close();
      } catch {
      }
      sessions.delete(sessionId);
    }
  }

  async function publishMobileTranscriptTail(sessionId: string, updatedAtOverride?: number): Promise<void> {
    if (!config.encryptionKey || !config.getMobileTranscriptTailJson || !indexWs || !indexConnected) {
      return;
    }
    if (!isMessageSyncDisabled(sessionId)) {
      return;
    }
    const cached = sessionIndexCache.get(sessionId);
    if (!cached) {
      return;
    }
    try {
      const mobileTranscriptTailJson = await config.getMobileTranscriptTailJson(
        sessionId,
        MOBILE_TRANSCRIPT_TAIL_COUNT,
      );
      if (!mobileTranscriptTailJson) {
        return;
      }
      const mobileTranscriptTailUpdatedAt = updatedAtOverride ?? cached.updatedAt;
      const updatedCache: CachedSessionIndex = {
        ...cached,
        mobileTranscriptTailJson,
        mobileTranscriptTailUpdatedAt,
        updatedAt: updatedAtOverride ?? cached.updatedAt,
        lastMessageAt: updatedAtOverride ?? cached.lastMessageAt,
      };
      const { encryptedProjectId, projectIdIv } = await encryptProjectId(updatedCache.projectId, config.encryptionKey);
      const indexEntry: SessionIndexEntry = {
        sessionId: updatedCache.sessionId,
        encryptedProjectId,
        projectIdIv,
        provider: updatedCache.provider,
        model: updatedCache.model,
        mode: updatedCache.mode,
        sessionType: updatedCache.sessionType,
        parentSessionId: updatedCache.parentSessionId,
        worktreeId: updatedCache.worktreeId,
        isArchived: updatedCache.isArchived,
        isPinned: updatedCache.isPinned,
        messageCount: updatedCache.messageCount,
        lastMessageAt: updatedCache.lastMessageAt,
        createdAt: updatedCache.createdAt,
        updatedAt: updatedCache.updatedAt,
        pendingExecution: updatedCache.pendingExecution,
        isExecuting: updatedCache.isExecuting,
        lastReadAt: updatedCache.lastReadAt,
      };
      if (updatedCache.title) {
        const { encryptedTitle, titleIv } = await encryptTitle(updatedCache.title, config.encryptionKey);
        indexEntry.encryptedTitle = encryptedTitle;
        indexEntry.titleIv = titleIv;
      }
      await attachQueuedPromptsToIndexEntry(indexEntry, updatedCache.queuedPrompts);
      const clientMeta = buildClientMetadataFromCacheEntry(updatedCache);
      if (clientMeta) {
        const { encryptedClientMetadata, clientMetadataIv } = await encryptClientMetadata(clientMeta, config.encryptionKey);
        indexEntry.encryptedClientMetadata = encryptedClientMetadata;
        indexEntry.clientMetadataIv = clientMetadataIv;
      }
      sessionIndexCache.set(sessionId, updatedCache);
      const indexMsg: ClientMessage = { type: 'indexUpdate', session: indexEntry };
      indexWs.send(JSON.stringify(indexMsg));
    } catch (err) {
      console.error('[CollabV3] Failed to publish mobile transcript tail:', err);
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
   * If `indexAuthBlocked` is set (JWT/userId mismatch detected), we don't
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
            console.warn('[CollabV3] Index reconnect blocked: JWT/userId mismatch. Waiting for explicit reconnect trigger.');
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

  // Listeners for generic session control messages (cancel, question_response, etc.)
  const sessionControlMessageListeners = new Set<(message: SessionControlMessage) => void>();

  // Connected devices tracking
  const connectedDevices = new Map<string, DeviceInfo>();
  const deviceStatusListeners = new Set<(devices: DeviceInfo[]) => void>();

  // Settings sync listeners (for receiving synced settings from other devices)
  const settingsSyncListeners = new Set<(settings: SyncedSettings) => void>();

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
    queuedPrompts: PlaintextQueuedPrompt[] | undefined
  ): Promise<void> {
    if (queuedPrompts === undefined) {
      return;
    }

    indexEntry.queuedPromptCount = queuedPrompts.length;
    if (queuedPrompts.length === 0) {
      indexEntry.encryptedQueuedPrompts = [];
      return;
    }
    const key = config.encryptionKey;
    if (!key) {
      throw new Error('[CollabV3] Cannot send queued prompts: no encryption key available');
    }
    indexEntry.encryptedQueuedPrompts = await encryptQueuedPrompts(queuedPrompts, key);
  }

  async function sendIndexUpdate(baseEntry: CachedSessionIndex): Promise<void> {
    if (!indexWs || !config.encryptionKey) {
      console.error('[CollabV3] Cannot send session update: index socket or encryption key missing');
      return;
    }

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

    await attachQueuedPromptsToIndexEntry(indexEntry, baseEntry.queuedPrompts);

    const clientMeta = buildClientMetadataFromCacheEntry(baseEntry);
    if (clientMeta) {
      const { encryptedClientMetadata, clientMetadataIv } = await encryptClientMetadata(clientMeta, config.encryptionKey);
      indexEntry.encryptedClientMetadata = encryptedClientMetadata;
      indexEntry.clientMetadataIv = clientMetadataIv;
    }

    sessionIndexCache.set(baseEntry.sessionId, baseEntry);
    const indexMsg: ClientMessage = { type: 'indexUpdate', session: indexEntry };
    indexWs.send(JSON.stringify(indexMsg));
  }

  async function sendIndexClientMetadataPatch(baseEntry: CachedSessionIndex): Promise<void> {
    if (!indexWs || !config.encryptionKey) {
      console.error('[CollabV3] Cannot send index metadata patch: index socket or encryption key missing');
      return;
    }

    const patch: IndexClientMetadataPatch = {
      sessionId: baseEntry.sessionId,
      isExecuting: baseEntry.isExecuting,
      lastReadAt: baseEntry.lastReadAt,
    };

    const clientMeta = buildClientMetadataFromCacheEntry(baseEntry);
    if (clientMeta) {
      const { encryptedClientMetadata, clientMetadataIv } = await encryptClientMetadata(clientMeta, config.encryptionKey);
      patch.encryptedClientMetadata = encryptedClientMetadata;
      patch.clientMetadataIv = clientMetadataIv;
    }

    sessionIndexCache.set(baseEntry.sessionId, baseEntry);
    const patchMsg: ClientMessage = { type: 'indexClientMetadataPatch', patch };
    indexWs.send(JSON.stringify(patchMsg));
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
      isArchived: 'isArchived' in pending ? pending.isArchived : cached.isArchived,
      isPinned: 'isPinned' in pending ? pending.isPinned : cached.isPinned,
      messageCount: cached.messageCount,
      lastMessageAt: cached.lastMessageAt,
      createdAt: cached.createdAt,
      updatedAt: pending.updatedAt ?? cached.updatedAt,
      pendingExecution: 'pendingExecution' in pending ? pending.pendingExecution : cached.pendingExecution,
      isExecuting: 'isExecuting' in pending ? pending.isExecuting : cached.isExecuting,
      queuedPrompts: 'queuedPrompts' in pending ? pending.queuedPrompts : cached.queuedPrompts,
      currentContext: 'currentContext' in pending ? pending.currentContext : cached.currentContext,
      hasPendingPrompt: 'hasPendingPrompt' in pending ? pending.hasPendingPrompt : cached.hasPendingPrompt,
      agentStatus: 'agentStatus' in pending ? (pending as any).agentStatus : cached.agentStatus,
      phase: 'phase' in pending ? (pending as any).phase : cached.phase,
      tags: 'tags' in pending ? (pending as any).tags : cached.tags,
      lastReadAt: 'lastReadAt' in pending ? (pending as any).lastReadAt : cached.lastReadAt,
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
    resolve: (result: { sessions: DecryptedSessionIndexEntry[]; projects: Array<{ projectId: string; name: string; sessionCount: number; lastActivityAt: number; syncEnabled: boolean }> }) => void;
    reject: (error: Error) => void;
  } | null = null;

  // Helper to announce device to the index server
  function announceDevice(): void {
    // Get current device info (prefer callback for dynamic presence, fallback to static)
    const deviceInfo = config.getDeviceInfo?.() ?? config.deviceInfo;
    // Check both our flag AND the actual WebSocket readyState to avoid "Sent before connected" errors
    if (deviceInfo && indexWs && indexConnected && indexWs.readyState === WebSocket.OPEN) {
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
      if (indexWs && indexWs.readyState === WebSocket.OPEN) {
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

  function buildRoomId(userId: string, suffix: string): string {
    return `org:${config.orgId}:user:${userId}:${suffix}`;
  }

  function getRoomId(sessionId: string): string {
    return buildRoomId(getUserId(), `session:${sessionId}`);
  }

  function getIndexRoomId(): string {
    return buildRoomId(getUserId(), 'index');
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
      id: parseInt(encrypted.id, 10) || 0,
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
      for (const encrypted of response.messages) {
        try {
          const decrypted = await decryptMessage(encrypted, session.encryptionKey);
          decrypted.sessionId = sessionId;

          session.changeListeners.forEach((cb) =>
            cb({ type: 'message_added', message: decrypted })
          );
        } catch (err) {
          console.error('[CollabV3] Failed to decrypt message:', err);
        }
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
        if ('agentStatus' in clientMeta) metadata.agentStatus = clientMeta.agentStatus;
        if (clientMeta.mobileTranscriptTailJson !== undefined) metadata.mobileTranscriptTailJson = clientMeta.mobileTranscriptTailJson;
        if (clientMeta.mobileTranscriptTailUpdatedAt !== undefined) metadata.mobileTranscriptTailUpdatedAt = clientMeta.mobileTranscriptTailUpdatedAt;
        if (clientMeta.mobileTranscriptHistoryPageJson !== undefined) metadata.mobileTranscriptHistoryPageJson = clientMeta.mobileTranscriptHistoryPageJson;
        if (clientMeta.mobileTranscriptHistoryPageUpdatedAt !== undefined) metadata.mobileTranscriptHistoryPageUpdatedAt = clientMeta.mobileTranscriptHistoryPageUpdatedAt;
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
    } else if (broadcast.metadata.queuedPromptCount === 0 || broadcast.metadata.encryptedQueuedPrompts?.length === 0) {
      metadata.queuedPrompts = [];
    }
    // If no encryptedQueuedPrompts field and no zero count, don't update queued prompts

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
      const err = new Error('CollabV3 index connection blocked: JWT/userId mismatch');
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
    let jwt: string;
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
    console.log('[CollabV3] connectToIndex() roomId:', indexRoomId, 'orgId:', config.orgId, 'userId:', getUserId());
    const url = getWebSocketUrl(indexRoomId);
    // Pass JWT via query parameter (WebSocket doesn't support custom headers in browsers)
    const wsUrl = appendSyncClientParams(`${url}?token=${encodeURIComponent(jwt)}`);

    indexWs = new WebSocket(wsUrl);

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
      console.error('[CollabV3] Index WebSocket error:', errorInfo, 'URL:', wsUrl);
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
              // Track sessions that fail decryption so we can delete them from the
              // server index. The next sync cycle will re-push them from the local
              // PGLite database with the correct encryption key.
              const decryptionFailedSessionIds: string[] = [];

              // Decrypt sensitive fields before returning
              const decryptedSessions: DecryptedSessionIndexEntry[] = (await Promise.all(
                message.sessions.map(async (entry): Promise<DecryptedSessionIndexEntry | null> => {
                  // Start with base fields that don't need transformation
                  let title: string;
                  let projectId: string;
                  let queuedPrompts: Array<{ id: string; prompt: string; timestamp: number }> | undefined;

                  // Decrypt projectId - encrypted projectId is required
                  if (entry.encryptedProjectId && entry.projectIdIv && config.encryptionKey) {
                    try {
                      projectId = await decryptProjectId(entry.encryptedProjectId, entry.projectIdIv, config.encryptionKey);
                    } catch (err) {
                      console.warn(`[CollabV3] Cannot decrypt session ${entry.sessionId} (wrong encryption key, likely from before userId migration). Deleting from server index so it re-syncs with correct key.`);
                      decryptionFailedSessionIds.push(entry.sessionId);
                      return null;
                    }
                  } else {
                    // No encrypted projectId - use placeholder
                    projectId = 'unknown';
                  }

                  // Decrypt title - encrypted titles are required
                  if (entry.encryptedTitle && entry.titleIv && config.encryptionKey) {
                    try {
                      title = await decryptTitle(entry.encryptedTitle, entry.titleIv, config.encryptionKey);
                    } catch (err) {
                      console.warn(`[CollabV3] Cannot decrypt session ${entry.sessionId} title (wrong encryption key). Deleting from server index so it re-syncs with correct key.`);
                      decryptionFailedSessionIds.push(entry.sessionId);
                      return null;
                    }
                  } else {
                    // No encrypted title - show as untitled until resynced
                    title = 'Untitled';
                  }

                  // Decrypt queued prompts - encrypted prompts are required
                  if (entry.encryptedQueuedPrompts && entry.encryptedQueuedPrompts.length > 0 && config.encryptionKey) {
                    try {
                      queuedPrompts = await decryptQueuedPrompts(entry.encryptedQueuedPrompts, config.encryptionKey);
                    } catch (err) {
                      // Non-fatal: queued prompts are transient, just skip
                      console.warn(`[CollabV3] Failed to decrypt queued prompts for session ${entry.sessionId}, skipping`);
                    }
                  } else if (entry.queuedPromptCount === 0 || entry.encryptedQueuedPrompts?.length === 0) {
                    queuedPrompts = [];
                  }

                  // Decrypt client metadata (context usage, pending prompt state, phase, tags, etc.)
                  let currentContext: CachedSessionIndex['currentContext'];
                  let agentStatus: SyncedAgentStatus | null | undefined;
                  let hasPendingPrompt: boolean | undefined;
                  let phase: string | undefined;
                  let tags: string[] | undefined;
                  let hasBeenNamed: boolean | undefined;
                  let mobileTranscriptTailJson: string | undefined;
                  let mobileTranscriptTailUpdatedAt: number | undefined;
                  let mobileTranscriptHistoryPageJson: string | undefined;
                  let mobileTranscriptHistoryPageUpdatedAt: number | undefined;
                  if (entry.encryptedClientMetadata && entry.clientMetadataIv && config.encryptionKey) {
                    try {
                      const clientMeta = await decryptClientMetadata(entry.encryptedClientMetadata, entry.clientMetadataIv, config.encryptionKey);
                      currentContext = clientMeta.currentContext;
                      agentStatus = clientMeta.agentStatus;
                      hasPendingPrompt = clientMeta.hasPendingPrompt;
                      phase = clientMeta.phase;
                      tags = clientMeta.tags;
                      hasBeenNamed = clientMeta.hasBeenNamed;
                      mobileTranscriptTailJson = clientMeta.mobileTranscriptTailJson;
                      mobileTranscriptTailUpdatedAt = clientMeta.mobileTranscriptTailUpdatedAt;
                      mobileTranscriptHistoryPageJson = clientMeta.mobileTranscriptHistoryPageJson;
                      mobileTranscriptHistoryPageUpdatedAt = clientMeta.mobileTranscriptHistoryPageUpdatedAt;
                    } catch (err) {
                      // Non-fatal: metadata is supplementary, just skip
                      console.warn(`[CollabV3] Failed to decrypt client metadata for session ${entry.sessionId}, skipping`);
                    }
                  }

                  const decrypted: DecryptedSessionIndexEntry = {
                    sessionId: entry.sessionId,
                    projectId: projectId,
                    title,
                    provider: entry.provider,
                    model: entry.model,
                    mode: entry.mode,
                    sessionType: entry.sessionType,
                    parentSessionId: entry.parentSessionId,
                    worktreeId: entry.worktreeId,
                    isArchived: entry.isArchived,
                    isPinned: entry.isPinned,
                    branchedFromSessionId: entry.branchedFromSessionId,
                    branchPointMessageId: entry.branchPointMessageId,
                    branchedAt: entry.branchedAt,
                    messageCount: entry.messageCount,
                    lastMessageAt: entry.lastMessageAt,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    pendingExecution: entry.pendingExecution,
                    isExecuting: entry.isExecuting,
                    queuedPromptCount: entry.queuedPromptCount,
                    queuedPrompts,
                    agentStatus,
                    hasPendingPrompt: hasPendingPrompt ?? entry.hasPendingPrompt,
                    currentContext,
                    mobileTranscriptTailJson,
                    mobileTranscriptTailUpdatedAt,
                    mobileTranscriptHistoryPageJson,
                    mobileTranscriptHistoryPageUpdatedAt,
                    lastReadAt: entry.lastReadAt,
                  };

                  // Cache the decrypted entry
                  const cacheEntry: CachedSessionIndex = {
                    sessionId: decrypted.sessionId,
                    projectId: decrypted.projectId,
                    title: decrypted.title,
                    provider: decrypted.provider,
                    model: decrypted.model,
                    mode: decrypted.mode,
                    sessionType: decrypted.sessionType,
                    parentSessionId: decrypted.parentSessionId,
                    worktreeId: decrypted.worktreeId,
                    isArchived: decrypted.isArchived,
                    isPinned: decrypted.isPinned,
                    branchedFromSessionId: decrypted.branchedFromSessionId,
                    branchPointMessageId: decrypted.branchPointMessageId,
                    branchedAt: decrypted.branchedAt,
                    messageCount: decrypted.messageCount,
                    lastMessageAt: decrypted.lastMessageAt,
                    createdAt: decrypted.createdAt,
                    updatedAt: decrypted.updatedAt,
                    pendingExecution: decrypted.pendingExecution,
                    isExecuting: decrypted.isExecuting,
                    queuedPrompts: decrypted.queuedPrompts,
                    agentStatus: decrypted.agentStatus,
                    hasPendingPrompt: decrypted.hasPendingPrompt,
                    currentContext: decrypted.currentContext,
                    phase,
                    tags,
                    hasBeenNamed,
                    mobileTranscriptTailJson,
                    mobileTranscriptTailUpdatedAt,
                    mobileTranscriptHistoryPageJson,
                    mobileTranscriptHistoryPageUpdatedAt,
                    lastReadAt: decrypted.lastReadAt,
                  };
                  sessionIndexCache.set(entry.sessionId, cacheEntry);

                  return decrypted;
                })
              )).filter((s): s is DecryptedSessionIndexEntry => s !== null);

              // Delete server-side index entries that couldn't be decrypted.
              // They were encrypted with a different key (e.g., before userId migration).
              // The next sync cycle will re-push them from the local PGLite database
              // with the correct encryption key.
              if (decryptionFailedSessionIds.length > 0 && indexWs && indexWs.readyState === WebSocket.OPEN) {
                console.log(`[CollabV3] Deleting ${decryptionFailedSessionIds.length} undecryptable index entries from server (will re-sync with correct key)`);
                for (const badSessionId of decryptionFailedSessionIds) {
                  sessionIndexCache.delete(badSessionId);
                  const deleteMsg: ClientMessage = { type: 'indexDelete', sessionId: badSessionId };
                  indexWs.send(JSON.stringify(deleteMsg));
                }
              }

              // Decrypt project entries (skip entries encrypted with the wrong key)
              const decryptedProjectsRaw = await Promise.all(
                message.projects.map(async (proj) => {
                  let projectId: string;
                  let name: string;

                  // Decrypt projectId - if this fails, the entry is corrupted/wrong-key
                  if (proj.encryptedProjectId && proj.projectIdIv && config.encryptionKey) {
                    try {
                      projectId = await decryptProjectId(proj.encryptedProjectId, proj.projectIdIv, config.encryptionKey);
                    } catch (err) {
                      // Encrypted with a different key - skip this entry entirely.
                      // The underlying sessions were already cleaned up by the session
                      // decryption cleanup above. The orphaned project entry will be
                      // cascade-deleted by the server's 24-hour TTL alarm.
                      return null;
                    }
                  } else {
                    projectId = 'unknown';
                  }

                  // Decrypt name
                  if (proj.encryptedName && proj.nameIv && config.encryptionKey) {
                    try {
                      name = await decryptProjectName(proj.encryptedName, proj.nameIv, config.encryptionKey);
                    } catch (err) {
                      // Name failed but projectId succeeded - use fallback name
                      name = projectId.split('/').pop() ?? 'Unknown';
                    }
                  } else {
                    name = projectId.split('/').pop() ?? 'Unknown';
                  }

                  return {
                    projectId: projectId,
                    name,
                    sessionCount: proj.sessionCount,
                    lastActivityAt: proj.lastActivityAt,
                    syncEnabled: proj.syncEnabled,
                    gitRemoteHash: proj.gitRemoteHash,
                  };
                })
              );
              const decryptedProjects = decryptedProjectsRaw.filter((p): p is NonNullable<typeof p> => p !== null);
              if (decryptedProjectsRaw.length !== decryptedProjects.length) {
                // console.log(`[CollabV3] Filtered out ${decryptedProjectsRaw.length - decryptedProjects.length} undecryptable project entries (will be cleaned up by server TTL)`);
              }

              pendingIndexFetch.resolve({
                sessions: decryptedSessions,
                projects: decryptedProjects,
              });
              pendingIndexFetch = null;
            }
            break;
          }

          case 'indexBroadcast': {
            // Another device updated a session - decrypt sensitive fields first
            const entry = message.session;
            // console.log('[CollabV3] DEBUG indexBroadcast received for session:', entry.sessionId, 'hasClientMeta:', !!entry.encryptedClientMetadata, 'fromConnectionId:', message.fromConnectionId);

            // Decrypt projectId - encrypted projectId is required
            let projectId: string;
            if (entry.encryptedProjectId && entry.projectIdIv && config.encryptionKey) {
              try {
                projectId = await decryptProjectId(entry.encryptedProjectId, entry.projectIdIv, config.encryptionKey);
              } catch (err) {
                console.error('[CollabV3] Failed to decrypt index entry projectId:', err);
                projectId = 'unknown';
              }
            } else {
              projectId = 'unknown';
            }

            const decryptedEntry: CachedSessionIndex = {
              sessionId: entry.sessionId,
              projectId: projectId,
              title: 'Untitled', // Will be overwritten if encrypted title present
              provider: entry.provider,
              model: entry.model,
              mode: entry.mode,
              sessionType: entry.sessionType,
              parentSessionId: entry.parentSessionId,
              worktreeId: entry.worktreeId,
              isArchived: entry.isArchived,
              isPinned: entry.isPinned,
              branchedFromSessionId: entry.branchedFromSessionId,
              branchPointMessageId: entry.branchPointMessageId,
              branchedAt: entry.branchedAt,
              messageCount: entry.messageCount,
              lastMessageAt: entry.lastMessageAt,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
              pendingExecution: entry.pendingExecution,
              isExecuting: entry.isExecuting,
              hasPendingPrompt: entry.hasPendingPrompt,
              lastReadAt: entry.lastReadAt,
            };

            // Decrypt client metadata (context usage, pending prompt state, draft, etc.)
            if (entry.encryptedClientMetadata && entry.clientMetadataIv && config.encryptionKey) {
              try {
                const clientMeta = await decryptClientMetadata(entry.encryptedClientMetadata, entry.clientMetadataIv, config.encryptionKey);
                decryptedEntry.currentContext = clientMeta.currentContext;
                if (clientMeta.hasPendingPrompt !== undefined) {
                  decryptedEntry.hasPendingPrompt = clientMeta.hasPendingPrompt;
                }
                if ('agentStatus' in clientMeta) decryptedEntry.agentStatus = clientMeta.agentStatus;
                if (clientMeta.phase) decryptedEntry.phase = clientMeta.phase;
                if (clientMeta.tags) decryptedEntry.tags = clientMeta.tags;
                if (clientMeta.hasBeenNamed !== undefined) decryptedEntry.hasBeenNamed = clientMeta.hasBeenNamed;
                if (clientMeta.mobileTranscriptTailJson !== undefined) decryptedEntry.mobileTranscriptTailJson = clientMeta.mobileTranscriptTailJson;
                if (clientMeta.mobileTranscriptTailUpdatedAt !== undefined) decryptedEntry.mobileTranscriptTailUpdatedAt = clientMeta.mobileTranscriptTailUpdatedAt;
                if (clientMeta.mobileTranscriptHistoryPageJson !== undefined) decryptedEntry.mobileTranscriptHistoryPageJson = clientMeta.mobileTranscriptHistoryPageJson;
                if (clientMeta.mobileTranscriptHistoryPageUpdatedAt !== undefined) decryptedEntry.mobileTranscriptHistoryPageUpdatedAt = clientMeta.mobileTranscriptHistoryPageUpdatedAt;
              } catch (err) {
                console.error('[CollabV3] Failed to decrypt client metadata:', err);
              }
            }

            // Decrypt title - encrypted titles are required
            if (entry.encryptedTitle && entry.titleIv && config.encryptionKey) {
              try {
                decryptedEntry.title = await decryptTitle(entry.encryptedTitle, entry.titleIv, config.encryptionKey);
              } catch (err) {
                console.error('[CollabV3] Failed to decrypt index entry title:', err);
                decryptedEntry.title = 'Untitled';
              }
            }
            // If no encrypted title, keep as 'Untitled'

            // Decrypt queued prompts - encrypted prompts are required
              if (entry.encryptedQueuedPrompts && entry.encryptedQueuedPrompts.length > 0 && config.encryptionKey) {
                try {
                  console.log('[CollabV3] DEBUG decrypting queued prompts:', entry.encryptedQueuedPrompts.length);
                  decryptedEntry.queuedPrompts = await decryptQueuedPrompts(entry.encryptedQueuedPrompts, config.encryptionKey);
                  console.log('[CollabV3] DEBUG decrypted:', decryptedEntry.queuedPrompts?.length, 'prompts');
                } catch (err) {
                  console.error('[CollabV3] Failed to decrypt index entry queued prompts:', err);
                }
              } else if (entry.queuedPromptCount === 0 || entry.encryptedQueuedPrompts?.length === 0) {
                decryptedEntry.queuedPrompts = [];
              } else {
              // console.log('[CollabV3] DEBUG no encrypted prompts to decrypt:', {
              //   hasEncryptedPrompts: !!entry.encryptedQueuedPrompts,
              //   length: entry.encryptedQueuedPrompts?.length ?? 0,
              //   hasEncryptionKey: !!config.encryptionKey,
              // });
            }
            // If no encrypted prompts and no zero count, queuedPrompts stays undefined

            // Cache the decrypted entry
            sessionIndexCache.set(entry.sessionId, decryptedEntry);
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

          case 'createSessionRequestBroadcast': {
            // Another device (mobile) requested session creation
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
              timestamp: message.request.timestamp,
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

          case 'createWorktreeRequestBroadcast': {
            // Another device (mobile) requested worktree creation
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
            const controlMessage: SessionControlMessage = {
              sessionId: message.message.sessionId,
              type: message.message.messageType,
              payload: message.message.payload,
              timestamp: message.message.timestamp,
              sentBy: message.message.sentBy,
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
            const ourDeviceId = config.getDeviceInfo?.()?.deviceId ?? config.deviceInfo?.deviceId;
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

          case 'error':
            console.error('[CollabV3] Index error:', message.code, message.message);
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
  //   userId: config.userId,
  //   hasEncryptionKey: !!config.encryptionKey,
  // });

  // Start index connection. If the JWT mismatches the configured userId,
  // ensureFreshJwt sets indexAuthBlocked and throws -- we swallow it here so we
  // don't fire an unhandled promise rejection at startup. A later explicit
  // reconnectIndex() (network change / settings update / auth refresh) will
  // clear indexAuthBlocked and try again. Other errors fall through to the
  // existing scheduleIndexReconnect path via the onclose handler.
  connectToIndex().catch(err => {
    if (isAuthMismatchError(err)) {
      console.warn('[CollabV3] Initial index connect blocked: JWT/userId mismatch. Waiting for explicit reconnect trigger.');
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
    if (!config.encryptionKey) {
      console.error('[CollabV3] Cannot sync messages - no encryption key');
      return;
    }

    // console.log('[CollabV3] syncSessionMessages() - CREATING TEMP WebSocket for session', sessionId, 'with', messages.length, 'messages');

    // Get fresh JWT before connecting
    const { jwt } = await ensureFreshJwt();

    // Connect to session room
    const roomId = getRoomId(sessionId);
    const url = getWebSocketUrl(roomId);
    // Pass JWT via query parameter (WebSocket doesn't support custom headers in browsers)
    const wsUrl = appendSyncClientParams(`${url}?token=${encodeURIComponent(jwt)}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
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
      const sessionIds = messageSyncRequests.map(r => r.sessionId);

      // console.log('[CollabV3] Lazy batch syncing messages for', sessionIds.length, 'sessions in batches of', batchSize);

      for (let i = 0; i < sessionIds.length; i += batchSize) {
        const batchIds = sessionIds.slice(i, i + batchSize);
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

    // console.log('[CollabV3] Syncing', sessionsData.length, 'sessions to index');

    // Build all entries, encrypting sensitive fields
    const entries: SessionIndexEntry[] = await Promise.all(sessionsData.map(async session => {
      const projectId = session.workspaceId ?? 'default';

      // Encrypt projectId - encryption is required
      if (!config.encryptionKey) {
        throw new Error('[CollabV3] Cannot send session: no encryption key for projectId');
      }
      const { encryptedProjectId, projectIdIv } = await encryptProjectId(projectId, config.encryptionKey);

      // Check if we have cached execution/prompt state for this session
      const existingCache = sessionIndexCache.get(session.id);
      const pending = pendingMetadataUpdates.get(session.id);
      const cachedIsExecuting = pending?.isExecuting ?? existingCache?.isExecuting;
      const cachedHasPendingPrompt = pending?.hasPendingPrompt ?? existingCache?.hasPendingPrompt;
      const cachedAgentStatus = (pending as any)?.agentStatus ?? existingCache?.agentStatus;
      const cachedLastReadAt = pending?.lastReadAt ?? existingCache?.lastReadAt;

      const entry: SessionIndexEntry = {
        sessionId: session.id,
        encryptedProjectId,
        projectIdIv,
        provider: session.provider,
        model: session.model,
        mode: session.mode as SessionIndexEntry['mode'],
        sessionType: session.sessionType,
        parentSessionId: session.parentSessionId,
        worktreeId: session.worktreeId,
        isArchived: session.isArchived,
        isPinned: session.isPinned,
        branchedFromSessionId: session.branchedFromSessionId,
        branchPointMessageId: session.branchPointMessageId,
        branchedAt: session.branchedAt,
        messageCount: session.messageCount,
        lastMessageAt: session.updatedAt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        isExecuting: cachedIsExecuting,
        lastReadAt: cachedLastReadAt,
      };

      // Encrypt title - encryption is required
      if (session.title) {
        const { encryptedTitle, titleIv } = await encryptTitle(session.title, config.encryptionKey);
        entry.encryptedTitle = encryptedTitle;
        entry.titleIv = titleIv;
      }

      // Encrypt client metadata (context usage, pending prompt state, etc.)
      const rawClientMeta = buildClientMetadataFromRaw(session.metadata, {
        hasBeenNamed: session.hasBeenNamed,
      });
      // Merge in transient fields that are not reliably persisted in PGLite before sync runs.
      const clientMeta: ClientMetadata | undefined =
        rawClientMeta ||
        cachedHasPendingPrompt !== undefined ||
        cachedAgentStatus !== undefined ||
        pending?.currentContext !== undefined ||
        pending?.phase !== undefined ||
        pending?.tags !== undefined ||
        pending?.hasBeenNamed !== undefined
          ? {
              ...rawClientMeta,
              currentContext: pending?.currentContext ?? rawClientMeta?.currentContext,
              hasPendingPrompt: cachedHasPendingPrompt,
              agentStatus: cachedAgentStatus,
              phase: pending?.phase ?? rawClientMeta?.phase,
              tags: pending?.tags ?? rawClientMeta?.tags,
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
        isArchived: session.isArchived,
        isPinned: session.isPinned,
        branchedFromSessionId: session.branchedFromSessionId,
        branchPointMessageId: session.branchPointMessageId,
        branchedAt: session.branchedAt,
        messageCount: session.messageCount,
        lastMessageAt: session.updatedAt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        currentContext: clientMeta?.currentContext,
        isExecuting: cachedIsExecuting,
        hasPendingPrompt: cachedHasPendingPrompt,
        agentStatus: clientMeta?.agentStatus,
        phase: clientMeta?.phase,
        tags: clientMeta?.tags,
        lastReadAt: cachedLastReadAt,
        hasBeenNamed: clientMeta?.hasBeenNamed,
      };
      sessionIndexCache.set(session.id, cacheEntry);

      // Apply any pending metadata updates (e.g., isExecuting set before cache was populated)
      // Note: This is fire-and-forget since we're already sending the encrypted entry
      applyPendingMetadataUpdates(session.id).catch(err => {
        console.error('[CollabV3] Error applying pending metadata updates:', err);
      });

      return entry;
    }));

    // Use batch API if we have multiple sessions, otherwise single update
    if (entries.length > 1) {
      const msg: ClientMessage = { type: 'indexBatchUpdate', sessions: entries };
      const msgStr = JSON.stringify(msg);
      console.log('[CollabV3] Sending batch index update:', entries.length, 'sessions, message length:', msgStr.length);
      indexWs.send(msgStr);
    } else if (entries.length === 1) {
      const msg: ClientMessage = { type: 'indexUpdate', session: entries[0] };
      indexWs.send(JSON.stringify(msg));
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
      // Track this session as wanted so we re-subscribe after reconnects.
      // Do this before the short-circuit so callers resubscribing an already-connected
      // session (e.g. after the Map got deleted on onclose) still register intent.
      wantedSessions.add(sessionId);
      if (sessions.has(sessionId)) {
        // console.log(`[CollabV3] connect() - already connected to session ${sessionId}`);
        return; // Already connected
      }

      // Short-circuit when the JWT/userId mismatch latch is set. The server
      // would reject any session WebSocket against this room, and an active
      // agent streams ~10 messages/sec -- without this guard every message
      // hit `ensureFreshJwt()`, threw AUTH_MISMATCH, and flooded main.log
      // (1686/4986 lines during a single mobile-build session on 2026-05-21).
      // The latch clears on reconnectIndex() / disconnectAll(), so legitimate
      // signals (network change, settings update, auth refresh) still
      // unblock subsequent connects.
      if (indexAuthBlocked) {
        const err = new Error('CollabV3 session connection blocked: JWT/userId mismatch');
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
      let jwt: string;
      try {
        ({ jwt } = await ensureFreshJwt());
      } catch (err) {
        if (isAuthMismatchError(err)) {
          indexAuthBlocked = true;
        }
        throw err;
      }

      const roomId = getRoomId(sessionId);
      const url = getWebSocketUrl(roomId);
      // Pass JWT via query parameter (WebSocket doesn't support custom headers in browsers)
      const wsUrl = appendSyncClientParams(`${url}?token=${encodeURIComponent(jwt)}`);

      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);

        const session: SessionConnection = {
          ws,
          status: createInitialStatus(),
          statusListeners: new Set(),
          changeListeners: new Set(),
          lastSequence: 0,
          encryptionKey: config.encryptionKey,
          lastActivity: Date.now(),
        };

        sessions.set(sessionId, session);

        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
          ws.close();
          sessions.delete(sessionId);
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
          // Auth rejections (expired/invalid JWT) arrive here as a close
          // frame, not as an error event. Logging code/reason makes the
          // root cause visible the next time something goes wrong.
          console.log(
            `[CollabV3] Session WebSocket closed for ${sessionId} (code=${event?.code ?? 'unknown'}, reason="${event?.reason ?? ''}", wasClean=${event?.wasClean ?? 'unknown'})`,
          );
          updateStatus(sessionId, { connected: false });
          sessions.delete(sessionId);
        };

        ws.onerror = (event) => {
          // onerror itself carries little -- the close frame that follows has
          // the actionable code/reason. Keep this log as a breadcrumb only.
          const errorInfo = typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent
            ? { message: event.message, error: event.error }
            : { type: event.type, target: (event.target as WebSocket)?.url };
          console.error(`[CollabV3] WebSocket error for ${sessionId}:`, errorInfo, 'URL:', wsUrl);
          updateStatus(sessionId, { connected: false, error: 'Connection error' });
        };

        ws.onmessage = (event) => {
          // Update activity timestamp on message receive
          const sess = sessions.get(sessionId);
          if (sess) sess.lastActivity = Date.now();
          handleServerMessage(sessionId, event.data);
        };
      });
    },

    disconnect(sessionId: string): void {
      // Caller explicitly no longer wants this session -- drop intent so it
      // isn't resubscribed on the next index reconnect.
      wantedSessions.delete(sessionId);
      const session = sessions.get(sessionId);
      if (!session) return;

      session.ws.close();
      sessions.delete(sessionId);
    },

    disconnectAll(): void {
      wantedSessions.clear();
      for (const sessionId of sessions.keys()) {
        this.disconnect(sessionId);
      }

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
    },

    isConnected(sessionId: string): boolean {
      const session = sessions.get(sessionId);
      return session?.status.connected ?? false;
    },

    isAuthMismatched(): boolean {
      return indexAuthBlocked;
    },

    getStatus(sessionId: string): SyncStatus {
      const session = sessions.get(sessionId);
      return session?.status ?? createInitialStatus();
    },

    onStatusChange(sessionId: string, callback: (status: SyncStatus) => void): () => void {
      const session = sessions.get(sessionId);
      if (!session) return () => {};

      session.statusListeners.add(callback);
      return () => session.statusListeners.delete(callback);
    },

    onRemoteChange(sessionId: string, callback: (change: SessionChange) => void): () => void {
      const session = sessions.get(sessionId);
      if (!session) return () => {};

      session.changeListeners.add(callback);
      return () => session.changeListeners.delete(callback);
    },

    async pushChange(sessionId: string, change: SessionChange): Promise<void> {
      const session = sessions.get(sessionId);
      const sessionConnected = session?.status.connected;
      if (isMessageSyncDisabled(sessionId) && change.type !== 'session_deleted') {
        if (change.type !== 'metadata_updated') {
          return;
        }
      }

      // For metadata-only updates (like hasPendingPrompt, isExecuting), we can push to the
      // index room even without a session room connection. The session room is only opened
      // when a user enters a session to sync messages - but index metadata updates should
      // always go through as long as the index WebSocket is connected.
      const canPushIndexOnly = change.type === 'metadata_updated' && indexWs && indexConnected && config.encryptionKey;

      if (!sessionConnected && !canPushIndexOnly) {
        console.warn('[CollabV3] Cannot push change - not connected:', sessionId, 'sessionExists:', !!session, 'indexConnected:', indexConnected, 'hasKey:', !!config.encryptionKey);
        return;
      }
      // console.log('[CollabV3] pushChange:', sessionId, 'type:', change.type, 'sessionConnected:', sessionConnected, 'indexOnly:', !sessionConnected && canPushIndexOnly);

      let clientMessage: ClientMessage | undefined;

      switch (change.type) {
        case 'message_added': {
          if (!session?.encryptionKey) {
            console.warn('[CollabV3] Cannot push message - no encryption key or session room not connected');
            return;
          }
          if (!shouldSyncMessageForSessionRoom(change.message.source, change.message.metadata, change.message.content)) {
            return;
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
            return;
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
              metadata.queuedPromptCount = change.metadata.queuedPrompts.length;
              metadata.encryptedQueuedPrompts = await encryptQueuedPrompts(change.metadata.queuedPrompts, config.encryptionKey);
            } else {
              metadata.queuedPromptCount = 0;
              metadata.encryptedQueuedPrompts = [];
            }
          }
          // Encrypt client metadata (context usage, pending prompt state, phase, tags, etc.)
          const hasClientMetaFields = ('currentContext' in change.metadata && change.metadata.currentContext) ||
            ('hasPendingPrompt' in change.metadata) ||
            ('agentStatus' in change.metadata) ||
            ('phase' in change.metadata) ||
            ('tags' in change.metadata) ||
            ('hasBeenNamed' in change.metadata) ||
            ('mobileTranscriptTailJson' in change.metadata) ||
            ('mobileTranscriptHistoryPageJson' in change.metadata);
          if (hasClientMetaFields && config.encryptionKey) {
            const cached = sessionIndexCache.get(sessionId);
            const clientMeta: ClientMetadata = {
              currentContext: ('currentContext' in change.metadata ? change.metadata.currentContext : cached?.currentContext) || undefined,
              hasPendingPrompt: 'hasPendingPrompt' in change.metadata ? change.metadata.hasPendingPrompt : cached?.hasPendingPrompt,
              agentStatus: 'agentStatus' in change.metadata ? (change.metadata as any).agentStatus : cached?.agentStatus,
              phase: 'phase' in change.metadata ? (change.metadata as any).phase : cached?.phase,
              tags: 'tags' in change.metadata ? (change.metadata as any).tags : cached?.tags,
              hasBeenNamed: 'hasBeenNamed' in change.metadata ? (change.metadata as any).hasBeenNamed : cached?.hasBeenNamed,
              mobileTranscriptTailJson: 'mobileTranscriptTailJson' in change.metadata ? (change.metadata as any).mobileTranscriptTailJson : cached?.mobileTranscriptTailJson,
              mobileTranscriptTailUpdatedAt: 'mobileTranscriptTailUpdatedAt' in change.metadata ? (change.metadata as any).mobileTranscriptTailUpdatedAt : cached?.mobileTranscriptTailUpdatedAt,
              mobileTranscriptHistoryPageJson: 'mobileTranscriptHistoryPageJson' in change.metadata ? (change.metadata as any).mobileTranscriptHistoryPageJson : cached?.mobileTranscriptHistoryPageJson,
              mobileTranscriptHistoryPageUpdatedAt: 'mobileTranscriptHistoryPageUpdatedAt' in change.metadata ? (change.metadata as any).mobileTranscriptHistoryPageUpdatedAt : cached?.mobileTranscriptHistoryPageUpdatedAt,
            };
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

      // Send to session room (if connected and we have a message to send)
      if (clientMessage && sessionConnected) {
        try {
          const json = JSON.stringify(clientMessage);
          // console.log('[CollabV3] Sending message, length:', json.length);
          session.ws.send(json);
          // Update activity timestamp on message send
          session.lastActivity = Date.now();
        } catch (err) {
          console.error('[CollabV3] Failed to send message:', err);
        }
      }

      // Handle index updates based on change type
      if (indexWs && indexConnected) {
        if (change.type === 'session_deleted') {
          // Delete from index and cache
          sessionIndexCache.delete(sessionId);
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
              isArchived: 'isArchived' in meta ? meta.isArchived : cached.isArchived,
              isPinned: 'isPinned' in meta ? (meta as any).isPinned : cached.isPinned,
              lastMessageAt: updatedAt ?? cached.lastMessageAt,
              updatedAt: updatedAt ?? cached.updatedAt,
              pendingExecution: 'pendingExecution' in meta ? meta.pendingExecution : cached.pendingExecution,
              isExecuting: 'isExecuting' in meta ? meta.isExecuting : cached.isExecuting,
              queuedPrompts: 'queuedPrompts' in meta ? meta.queuedPrompts : cached.queuedPrompts,
              currentContext: 'currentContext' in meta ? meta.currentContext : cached.currentContext,
              hasPendingPrompt: 'hasPendingPrompt' in meta ? meta.hasPendingPrompt : cached.hasPendingPrompt,
              agentStatus: 'agentStatus' in meta ? (meta as any).agentStatus : cached.agentStatus,
              phase: 'phase' in meta ? (meta as any).phase : cached.phase,
              tags: 'tags' in meta ? (meta as any).tags : cached.tags,
              lastReadAt: 'lastReadAt' in meta ? (meta as any).lastReadAt : cached.lastReadAt,
              hasBeenNamed: 'hasBeenNamed' in meta ? (meta as any).hasBeenNamed : cached.hasBeenNamed,
              mobileTranscriptTailJson: 'mobileTranscriptTailJson' in meta ? (meta as any).mobileTranscriptTailJson : cached.mobileTranscriptTailJson,
              mobileTranscriptTailUpdatedAt: 'mobileTranscriptTailUpdatedAt' in meta ? (meta as any).mobileTranscriptTailUpdatedAt : cached.mobileTranscriptTailUpdatedAt,
              mobileTranscriptHistoryPageJson: 'mobileTranscriptHistoryPageJson' in meta ? (meta as any).mobileTranscriptHistoryPageJson : cached.mobileTranscriptHistoryPageJson,
              mobileTranscriptHistoryPageUpdatedAt: 'mobileTranscriptHistoryPageUpdatedAt' in meta ? (meta as any).mobileTranscriptHistoryPageUpdatedAt : cached.mobileTranscriptHistoryPageUpdatedAt,
            };
            if (isIndexClientMetadataOnlyUpdate(meta)) {
              await sendIndexClientMetadataPatch(updatedCache);
            } else {
              await sendIndexUpdate(updatedCache);
            }
            if (updatedAt !== undefined && isMessageSyncDisabled(sessionId)) {
              await publishMobileTranscriptTail(sessionId, updatedAt);
            }
          } else if (meta.title && meta.provider) {
            // New session - need at least title and provider
            const now = updatedAt ?? Date.now();
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
              isArchived: meta.isArchived,
              isPinned: (meta as any).isPinned,
              messageCount: 0,
              lastMessageAt: now,
              createdAt: now,
              updatedAt: now,
              pendingExecution: meta.pendingExecution,
              isExecuting: meta.isExecuting,
              queuedPrompts: meta.queuedPrompts,
              currentContext: meta.currentContext,
              hasPendingPrompt: meta.hasPendingPrompt,
              agentStatus: (meta as any).agentStatus,
              phase: (meta as any).phase,
              tags: (meta as any).tags,
              lastReadAt: (meta as any).lastReadAt,
              hasBeenNamed: (meta as any).hasBeenNamed,
              mobileTranscriptTailJson: (meta as any).mobileTranscriptTailJson,
              mobileTranscriptTailUpdatedAt: (meta as any).mobileTranscriptTailUpdatedAt,
              mobileTranscriptHistoryPageJson: (meta as any).mobileTranscriptHistoryPageJson,
              mobileTranscriptHistoryPageUpdatedAt: (meta as any).mobileTranscriptHistoryPageUpdatedAt,
            };
            await sendIndexUpdate(newEntry);
            if (updatedAt !== undefined && isMessageSyncDisabled(sessionId)) {
              await publishMobileTranscriptTail(sessionId, updatedAt);
            }
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
              'isArchived' in meta ||
              'isPinned' in meta ||
              'queuedPrompts' in meta ||
              'currentContext' in meta ||
              'hasPendingPrompt' in meta ||
              'agentStatus' in meta ||
              'phase' in meta ||
              'tags' in meta ||
              'lastReadAt' in meta ||
              'hasBeenNamed' in meta ||
              'mobileTranscriptTailJson' in meta ||
              'mobileTranscriptTailUpdatedAt' in meta ||
              'mobileTranscriptHistoryPageJson' in meta ||
              'mobileTranscriptHistoryPageUpdatedAt' in meta ||
              'updatedAt' in meta;
            if (hasPartialUpdate) {
              // console.log('[CollabV3] Queueing partial metadata update for session:', sessionId, { isExecuting: meta.isExecuting, pendingExecution: meta.pendingExecution, title: meta.title });
              const existing = pendingMetadataUpdates.get(sessionId) || {};
              if ('isExecuting' in meta) existing.isExecuting = meta.isExecuting;
              if ('pendingExecution' in meta) existing.pendingExecution = meta.pendingExecution;
              if ('queuedPrompts' in meta) existing.queuedPrompts = meta.queuedPrompts;
              if (meta.title !== undefined) existing.title = meta.title;
              if ('sessionType' in meta) existing.sessionType = meta.sessionType;
              if ('parentSessionId' in meta) existing.parentSessionId = meta.parentSessionId;
              if ('worktreeId' in meta) existing.worktreeId = (meta as any).worktreeId;
              if ('isArchived' in meta) existing.isArchived = meta.isArchived;
              if ('isPinned' in meta) existing.isPinned = (meta as any).isPinned;
              if ('currentContext' in meta) existing.currentContext = meta.currentContext;
              if ('hasPendingPrompt' in meta) existing.hasPendingPrompt = meta.hasPendingPrompt;
              if ('agentStatus' in meta) (existing as any).agentStatus = (meta as any).agentStatus;
              if ('phase' in meta) (existing as any).phase = (meta as any).phase;
              if ('tags' in meta) (existing as any).tags = (meta as any).tags;
              if ('lastReadAt' in meta) (existing as any).lastReadAt = (meta as any).lastReadAt;
              if ('hasBeenNamed' in meta) (existing as any).hasBeenNamed = (meta as any).hasBeenNamed;
              if ('mobileTranscriptTailJson' in meta) (existing as any).mobileTranscriptTailJson = (meta as any).mobileTranscriptTailJson;
              if ('mobileTranscriptTailUpdatedAt' in meta) (existing as any).mobileTranscriptTailUpdatedAt = (meta as any).mobileTranscriptTailUpdatedAt;
              if ('mobileTranscriptHistoryPageJson' in meta) (existing as any).mobileTranscriptHistoryPageJson = (meta as any).mobileTranscriptHistoryPageJson;
              if ('mobileTranscriptHistoryPageUpdatedAt' in meta) (existing as any).mobileTranscriptHistoryPageUpdatedAt = (meta as any).mobileTranscriptHistoryPageUpdatedAt;
              if ('updatedAt' in meta) existing.updatedAt = meta.updatedAt;
              pendingMetadataUpdates.set(sessionId, existing);
            } else {
              // console.log('[CollabV3] Skipping index update - no cached data and missing required fields for session:', sessionId);
            }
          }
        }
      }
    },

    syncSessionsToIndex(sessionsData: SessionIndexData[], options?: {
      syncMessages?: boolean;
      messageSyncRequests?: Array<{ sessionId: string; sinceTimestamp: number }>;
      getMessagesForSync?: (requests: Array<{ sessionId: string; sinceTimestamp: number }>) => Promise<Map<string, any[]>>;
    }): void {
      if (!indexWs || !indexConnected) {
        // Queue the operation to run when connection is established
        console.log('[CollabV3] Index not connected yet, queueing sync of', sessionsData.length, 'sessions');
        pendingOperations.push({ type: 'sessions', data: sessionsData, options });
        return;
      }

      // console.log('[CollabV3] syncSessionsToIndex called with', sessionsData.length, 'sessions, ids:', sessionsData.map(s => s.id).join(', '));

      // Call the helper function
      // Note: async but this method returns void for backwards compatibility
      doSyncSessionsToIndex(sessionsData, options).catch(err => {
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

      // Encrypt project ID (deterministic)
      const { encryptedProjectId, projectIdIv } = await encryptProjectId(projectId, config.encryptionKey);

      // Build message -- only include encrypted config if there are commands
      // (skip when just sending gitRemoteHash on startup to avoid overwriting existing config)
      const message: Record<string, unknown> = {
        type: 'projectConfigUpdate',
        encryptedProjectId,
        projectIdIv,
        gitRemoteHash: projectConfig.gitRemoteHash,
      };

      if (projectConfig.commands.length > 0) {
        const configJson = JSON.stringify(projectConfig);
        const { encrypted: encryptedConfig, iv: configIv } = await encrypt(configJson, config.encryptionKey);
        message.encryptedConfig = encryptedConfig;
        message.configIv = configIv;
      }

      indexWs.send(JSON.stringify(message));
      // console.log('[CollabV3] Sent projectConfigUpdate with', projectConfig.commands.length, 'commands');
    },

    async fetchIndex(): Promise<{ sessions: DecryptedSessionIndexEntry[]; projects: Array<{ projectId: string; name: string; sessionCount: number; lastActivityAt: number; syncEnabled: boolean; gitRemoteHash?: string }> }> {
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

      const msg: ClientMessage = { type: 'createSessionRequest', request: wireRequest };
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
        const deviceId = config.getDeviceInfo?.()?.deviceId ?? config.deviceInfo?.deviceId ?? 'unknown';

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
        if (indexWs.readyState !== WebSocket.OPEN) {
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

    /** Request the sync server to send a push notification to mobile devices */
    async requestMobilePush(sessionId: string, title: string, body: string): Promise<void> {
      // Ensure we're connected before sending the request
      if (!indexWs || !indexConnected) {
        console.log('[CollabV3] Not connected to index, attempting to reconnect before requesting mobile push...');
        try {
          await connectToIndex();
        } catch (err) {
          console.error('[CollabV3] Failed to connect to index before requesting mobile push:', err);
          return;
        }
      }

      // Double-check connection and WebSocket state after await
      if (!indexWs || !indexConnected) {
        console.error('[CollabV3] Cannot request mobile push - failed to establish connection');
        return;
      }

      // Check actual WebSocket state
      if (indexWs.readyState !== WebSocket.OPEN) {
        console.error('[CollabV3] Cannot request mobile push - WebSocket not open, state:', indexWs.readyState);
        return;
      }

      const deviceId = config.getDeviceInfo?.()?.deviceId ?? config.deviceInfo?.deviceId;
      const msg: ClientMessage = {
        type: 'requestMobilePush',
        sessionId: sessionId,
        title,
        body,
        requestingDeviceId: deviceId,
      };
      // console.log('[CollabV3] Requesting mobile push for session:', sessionId, 'deviceId:', deviceId, 'readyState:', indexWs.readyState);
      try {
        indexWs.send(JSON.stringify(msg));
        // console.log('[CollabV3] Mobile push message sent successfully');
      } catch (error) {
        console.error('[CollabV3] Failed to send mobile push message:', error);
      }
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
      if (indexWs && !indexConnected && indexWs.readyState === WebSocket.CONNECTING) {
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
