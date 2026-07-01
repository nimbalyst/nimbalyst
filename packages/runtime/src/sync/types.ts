/**
 * Types for the optional Y.js sync layer.
 *
 * This module provides device sync for AI sessions using Y.js CRDTs.
 * It's designed to be completely optional - the app works without it.
 */

import type { AgentMessage } from '../ai/server/types';

export interface SyncConfig {
  /** WebSocket server URL (e.g., ws://localhost:8787 or wss://sync.nimbalyst.com) */
  serverUrl: string;

  /**
   * Function to get a fresh JWT for authentication.
   * Called before each WebSocket connection to ensure the JWT isn't expired.
   * JWTs typically expire in ~5 minutes, so this must return a fresh one.
   */
  getJwt: () => Promise<string>;

  /** B2B organization ID for org-scoped room IDs. */
  orgId: string;

  /**
   * Stable user ID for room ID construction.
   * In Stytch B2B, the JWT 'sub' claim is the member ID which differs per org.
   * After a team session exchange, the JWT sub becomes the team org member ID,
   * but sync room IDs must use the personal org member ID to stay consistent
   * across devices. If provided, this takes precedence over extracting from JWT.
   */
  userId?: string;

  /** Optional encryption key for E2E encryption */
  encryptionKey?: CryptoKey;

  /** Device info for presence awareness (static - set once at init) */
  deviceInfo?: DeviceInfo;

  /**
   * Function to get current device info for presence updates.
   * Called periodically (every 30s) to get up-to-date presence info.
   * If provided, takes precedence over static deviceInfo.
   */
  getDeviceInfo?: () => DeviceInfo;
}

/**
 * Information about a connected device.
 * Used for device awareness/presence in the IndexRoom.
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

export interface SyncStatus {
  connected: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
}

export interface SyncProvider {
  /** Connect to sync server for a session */
  connect(sessionId: string): Promise<void>;

  /** Disconnect from sync server */
  disconnect(sessionId: string): void;

  /** Disconnect all sessions */
  disconnectAll(): void;

  /** Check if a session is connected */
  isConnected(sessionId: string): boolean;

  /**
   * Returns true when the provider has latched a JWT/userId mismatch
   * (server-rejected, locally refused). Callers in hot paths (e.g.
   * MessageSyncHandler running on every agent message) should consult
   * this before attempting connect() to avoid log floods and CPU spin.
   * Optional so non-Stytch-backed providers don't have to implement it.
   */
  isAuthMismatched?(): boolean;

  /** Get sync status for a session */
  getStatus(sessionId: string): SyncStatus;

  /** Subscribe to sync status changes */
  onStatusChange(
    sessionId: string,
    callback: (status: SyncStatus) => void
  ): () => void;

  /** Subscribe to remote changes */
  onRemoteChange(
    sessionId: string,
    callback: (change: SessionChange) => void
  ): () => void;

  /** Push local changes to sync */
  pushChange(sessionId: string, change: SessionChange): void;

  /** Bulk update the sessions index with existing sessions */
  syncSessionsToIndex?(sessions: SessionIndexData[], options?: {
    syncMessages?: boolean;
    /** Per-session sinceTimestamp for lazy message loading. Provider loads messages
     *  in small batches using getMessagesForSync instead of pre-loading all at once. */
    messageSyncRequests?: Array<{ sessionId: string; sinceTimestamp: number }>;
    /** Callback to load messages for a batch of sessions. Called lazily by the provider
     *  so PGLite isn't blocked loading all messages upfront. */
    getMessagesForSync?: (requests: Array<{ sessionId: string; sinceTimestamp: number }>) => Promise<Map<string, any[]>>;
  }): void;

  /** Sync projects to the ProjectsIndex (tells mobile which projects exist and are enabled) */
  syncProjectsToIndex?(projects: ProjectIndexEntry[]): void;

  /** Sync project config (commands, settings) to the index room for mobile access */
  syncProjectConfig?(projectId: string, config: ProjectConfig): void;

  /** Fetch the current server index to compare with local state */
  fetchIndex?(): Promise<{
    sessions: Array<{
      sessionId: string;
      projectId: string;
      title: string;
      provider: string;
      model?: string;
      mode?: 'agent' | 'planning';
      sessionType?: string;
      parentSessionId?: string;
      worktreeId?: string;
      isArchived?: boolean;
      isPinned?: boolean;
      messageCount: number;
      lastMessageAt: number;
      createdAt: number;
      updatedAt: number;
      pendingExecution?: {
        messageId: string;
        sentAt: number;
        sentBy: 'mobile' | 'desktop';
      };
      isExecuting?: boolean;
    }>;
    projects: Array<{
      projectId: string;
      name: string;
      sessionCount: number;
      lastActivityAt: number;
      syncEnabled: boolean;
      gitRemoteHash?: string;
    }>;
  }>;

  /** Subscribe to index changes (session updates broadcast to all connected clients) */
  onIndexChange?(callback: (sessionId: string, entry: {
    sessionId: string;
    title?: string;
    provider?: string;
    model?: string;
    mode?: 'agent' | 'planning';
    messageCount?: number;
    updatedAt?: number;
    lastMessageAt?: number;
    pendingExecution?: {
      messageId: string;
      sentAt: number;
      sentBy: 'mobile' | 'desktop';
    };
    isExecuting?: boolean;
    /** Unix timestamp ms when this session was last read by any device */
    lastReadAt?: number;
    /** Number of prompts queued from mobile, waiting for desktop to process */
    queuedPromptCount?: number;
    /** Full queue of prompts (sent via indexUpdate for desktop to process) */
    queuedPrompts?: Array<{ id: string; prompt: string; timestamp: number; attachments?: EncryptedAttachment[] }>;
    /** Draft input text (unsent message) from another device */
    draftInput?: string;
    /** Epoch ms when draftInput was last updated by the sending device */
    draftUpdatedAt?: number;
  }) => void): () => void;

  /** Get cached metadata for a session (populated from syncResponse and metadataBroadcast) */
  getCachedMetadata?(sessionId: string): {
    queuedPrompts?: Array<{
      id: string;
      prompt: string;
      timestamp: number;
      attachments?: EncryptedAttachment[];
    }>;
    [key: string]: unknown;
  } | undefined;

  /** Get cached index entry for a session (populated from indexSyncResponse and indexBroadcast)
   * Note: Returns decrypted values - title is always present after decryption */
  getCachedIndexEntry?(sessionId: string): {
    sessionId: string;
    projectId: string;
    /** Decrypted title (always present in cache) */
    title: string;
    provider: string;
    model?: string;
    mode?: 'agent' | 'planning';
    messageCount: number;
    lastMessageAt: number;
    createdAt: number;
    updatedAt: number;
    pendingExecution?: {
      messageId: string;
      sentAt: number;
      sentBy: 'mobile' | 'desktop';
    };
    isExecuting?: boolean;
    /** Decrypted queued prompts */
    queuedPrompts?: Array<{ id: string; prompt: string; timestamp: number }>;
  } | undefined;

  /** Clear isExecuting in all cached index entries (for startup cleanup) */
  clearAllExecutingState?(): void;

  /** Subscribe to session creation requests from other devices (e.g., mobile) */
  onCreateSessionRequest?(callback: (request: CreateSessionRequest) => void): () => void;

  /** Send a response to a session creation request */
  sendCreateSessionResponse?(response: CreateSessionResponse): Promise<void>;

  /** Send a session creation request (for mobile to request desktop to create a session) */
  sendCreateSessionRequest?(request: CreateSessionRequest): Promise<void>;

  /** Subscribe to session creation responses (for mobile to receive response from desktop) */
  onCreateSessionResponse?(callback: (response: CreateSessionResponse) => void): () => void;

  /** Subscribe to voice-tool requests from other devices (desktop runs the tool). */
  onVoiceToolRequest?(callback: (request: VoiceToolRequest) => void): () => void;

  /** Send a voice-tool result back to the requesting device (desktop -> mobile). */
  sendVoiceToolResponse?(response: VoiceToolResponse): Promise<void>;

  /** Send a voice-tool request (mobile -> desktop). */
  sendVoiceToolRequest?(request: VoiceToolRequest): Promise<void>;

  /** Subscribe to voice-tool responses (mobile receives the desktop result). */
  onVoiceToolResponse?(callback: (response: VoiceToolResponse) => void): () => void;

  /** Subscribe to worktree creation requests from other devices (e.g., mobile) */
  onCreateWorktreeRequest?(callback: (request: CreateWorktreeRequest) => void): () => void;

  /** Send a response to a worktree creation request */
  sendCreateWorktreeResponse?(response: CreateWorktreeResponse): Promise<void>;

  /** Send a generic session control message (cross-device via IndexRoom) */
  sendSessionControlMessage?(message: SessionControlMessage): Promise<void>;

  /** Subscribe to session control messages from other devices */
  onSessionControlMessage?(callback: (message: SessionControlMessage) => void): () => void;

  /**
   * Request the sync server to send a push notification to mobile devices.
   * Used when agent completes execution and user should be notified on mobile.
   * The server will check device presence before sending (suppresses if mobile is active).
   */
  requestMobilePush?(sessionId: string, title: string, body: string): Promise<void>;

  /** Get list of currently connected devices */
  getConnectedDevices?(): DeviceInfo[];

  /** Subscribe to device status changes (devices joining/leaving) */
  onDeviceStatusChange?(callback: (devices: DeviceInfo[]) => void): () => void;

  /**
   * Send encrypted settings to all connected mobile devices.
   * Used by desktop to share sensitive settings like API keys.
   */
  syncSettings?(settings: SyncedSettings): Promise<void>;

  /**
   * Subscribe to settings sync messages from other devices.
   * Used by mobile to receive settings from desktop.
   */
  onSettingsSync?(callback: (settings: SyncedSettings) => void): () => void;

  /**
   * Attempt to reconnect the index connection.
   * Called when network connectivity is restored after being offline.
   * Safe to call even if already connected (will no-op).
   */
  reconnectIndex?(): Promise<void>;

  /**
   * Returns true if the index is currently past its post-open stability window
   * and considered usable for fan-out to other sync providers.
   */
  isIndexReady?(): boolean;

  /**
   * Wait for the index to reach the `ready` state (open + stable). Resolves
   * immediately if already ready. Rejects after `timeoutMs` otherwise. Used by
   * the reconnect cascade to gate other providers on a verified-healthy index.
   */
  waitForIndexReady?(timeoutMs?: number): Promise<void>;

  /** Push a file index entry to the IndexRoom (for mobile markdown sync) */
  syncFileToIndex?(file: FileIndexData): void;

  /** Remove a file from the IndexRoom file index */
  deleteFileFromIndex?(docId: string): void;
}

/** File data for file index sync (unencrypted - will be encrypted before sending) */
export interface FileIndexData {
  /** Document sync ID from frontmatter */
  docId: string;
  /** Workspace project ID */
  projectId: string;
  /** Relative path within the project e.g. "notes/meeting.md" */
  relativePath: string;
  /** Display title (filename without extension) */
  title: string;
  /** Last modified timestamp (ms) */
  lastModifiedAt: number;
}

/** Session data for bulk index sync */
export interface SessionIndexData {
  id: string;
  title: string;
  provider: string;
  model?: string;
  mode?: string;
  /** Structural type: 'session' (normal), 'workstream' (parent container), 'blitz' (quick task) */
  sessionType?: string;
  /** Parent session ID for workstream/worktree hierarchy */
  parentSessionId?: string;
  /** Worktree ID for git worktree association */
  worktreeId?: string;
  /** Whether the session is archived */
  isArchived?: boolean;
  /** Whether the session is pinned */
  isPinned?: boolean;
  /** Marker that the title was AI-chosen; prevents repeated rename attempts. */
  hasBeenNamed?: boolean;
  /** Session ID this was branched/forked from */
  branchedFromSessionId?: string;
  /** Message ID at the branch point */
  branchPointMessageId?: number;
  /** When this session was branched (unix ms) */
  branchedAt?: number;
  workspaceId?: string;
  workspacePath?: string;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
  /** Raw metadata from PGLite - CollabV3Sync extracts what it needs for encrypted client metadata */
  metadata?: Record<string, any>;
  /** Optional messages to sync to the session Y.Doc */
  messages?: AgentMessage[];
}

/** Types of changes that can be synced */
export type SessionChange =
  | { type: 'message_added'; message: AgentMessage }
  | { type: 'metadata_updated'; metadata: Partial<SyncedSessionMetadata> }
  | { type: 'session_deleted' };

// AgentMessage is imported from ai/server/types.ts - the real database type
// We sync the raw database format; rendering uses canonical ai_transcript_events

/** Queued prompt for cross-device sync */
export interface SyncedQueuedPrompt {
  id: string;           // Unique ID for this queued item
  prompt: string;       // The user's message
  timestamp: number;    // When queued
  // Note: documentContext is NOT synced - it's device-local
  /** Encrypted image attachments from mobile */
  attachments?: EncryptedAttachment[];
}

/**
 * Encrypted image attachment sent from mobile via queued prompts.
 * Desktop decrypts the data, writes to temp file, and creates a ChatAttachment.
 */
export interface EncryptedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  /** Base64 AES-GCM ciphertext of the image data */
  encryptedData: string;
  /** Base64 IV for decryption */
  iv: string;
  /** Original size in bytes (before encryption) */
  size: number;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
}

/** Session metadata that gets synced */
export interface SyncedSessionMetadata {
  title?: string;
  mode?: string;
  /** Structural type: 'session' | 'workstream' | 'blitz' */
  sessionType?: string;
  /** Parent session ID for workstream/worktree hierarchy */
  parentSessionId?: string;
  /** Worktree association (mirrored from ai_sessions.worktree_id). */
  worktreeId?: string;
  provider?: string;
  model?: string;
  workspaceId?: string;
  workspacePath?: string;
  isArchived?: boolean;
  /** Whether the session is pinned in the list on every device. */
  isPinned?: boolean;
  /** Marker that the title was AI-chosen; prevents repeated rename attempts. */
  hasBeenNamed?: boolean;
  draftInput?: string;
  /** Epoch ms when draftInput was last updated by the sending device */
  draftUpdatedAt?: number;
  /**
   * Set only when the change should bump session sort order on iOS (title,
   * mode, archive, provider, model). Pins, reparents, archive flips, draft
   * input, etc. deliberately push without updatedAt so the row keeps its
   * place.
   */
  updatedAt?: number;
  /** Queued prompts waiting to be processed by desktop */
  queuedPrompts?: SyncedQueuedPrompt[];
  /** Signals that a message is waiting for desktop to process it */
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  /** Whether the session is currently executing (processing AI request) */
  isExecuting?: boolean;
  /** Current context usage (from /context command for Claude Code) */
  currentContext?: {
    tokens: number;         // Current tokens in context window
    contextWindow: number;  // Max context window size
  };
  /** Whether there are pending interactive prompts (permissions, questions, plan approvals, git commits) */
  hasPendingPrompt?: boolean;
  /** Kanban phase: backlog, planning, implementing, validating, complete */
  phase?: string;
  /** Arbitrary tags for categorization */
  tags?: string[];
  /** Unix timestamp ms when this session was last read by any device */
  lastReadAt?: number;
}

/**
 * Session entry in the session index
 * Used for session list display on both desktop and mobile
 */
export interface SessionIndexEntry {
  id: string;
  title: string;
  provider: string;
  model?: string;
  mode?: 'agent' | 'planning';
  /** Parent session ID for workstream/worktree hierarchy */
  parentSessionId?: string;
  /** Worktree ID for git worktree association */
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
  workspaceId?: string;
  workspacePath?: string;
  lastMessageAt: number;
  lastMessagePreview?: string;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
  /** Signals that a message is waiting for desktop to process it */
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  /** Whether the session is currently executing (processing AI request) */
  isExecuting?: boolean;
  /** Whether there are pending interactive prompts (permissions or questions) waiting for response */
  hasPendingPrompt?: boolean;
  /** Current context usage (from /context command for Claude Code) */
  currentContext?: {
    tokens: number;         // Current tokens in context window
    contextWindow: number;  // Max context window size
  };
  /** Unix timestamp ms when this session was last read by any device */
  lastReadAt?: number;
}

/**
 * Project/workspace entry in the ProjectsIndex Y.Doc
 * Lists all available projects so mobile knows what exists
 */
export interface ProjectIndexEntry {
  id: string; // workspace path
  name: string; // project name (extracted from path)
  path: string; // full workspace path
  sessionCount: number; // number of sessions in this project
  lastActivityAt: number; // timestamp of most recent session activity
  enabled: boolean; // whether this project is enabled for sync (user controlled)
  /** Project config (decrypted on client, encrypted on wire) */
  config?: ProjectConfig;
}

/**
 * Project-level config synced from desktop to mobile via the index room.
 * Encrypted as a blob in project_index.encrypted_config.
 * Extensible: add more project-level config here as needed.
 */
export interface ProjectConfig {
  /** Available slash commands for this project */
  commands: SyncedSlashCommand[];
  /** Timestamp of last commands update */
  lastCommandsUpdate: number;
  /** SHA-256 hash of the normalized git remote URL (for server-side project identity lookup) */
  gitRemoteHash?: string;
}

/**
 * Lightweight slash command manifest for sync.
 * Name and description only -- content stays on desktop.
 */
export interface SyncedSlashCommand {
  name: string;
  description?: string;
  source: 'builtin' | 'project' | 'user' | 'plugin';
}

/**
 * Request to create a new AI session from mobile.
 * Sent via index WebSocket, processed by desktop.
 */
export interface CreateSessionRequest {
  /** Unique request ID for tracking */
  requestId: string;
  /** Project/workspace ID to create the session in */
  projectId: string;
  /** Optional initial prompt to send after session creation */
  initialPrompt?: string;
  /** Session type: "session" (default), "workstream" (parent container) */
  sessionType?: string;
  /** Parent session ID for creating child sessions within a workstream */
  parentSessionId?: string;
  /** Provider ID selected by mobile (e.g., "claude-code"). Falls back to desktop default if omitted. */
  provider?: string;
  /** Model ID selected by mobile (e.g., "claude-code:opus"). Falls back to desktop default if omitted. */
  model?: string;
  /** Agent role (e.g., "meta-agent", "standard"). Falls back to "standard" if omitted. */
  agentRole?: string;
  /** Timestamp when request was created */
  timestamp: number;
}

/**
 * Response to a create session request.
 * Sent by desktop after session is created.
 */
export interface CreateSessionResponse {
  /** Request ID this is responding to */
  requestId: string;
  /** Whether session creation succeeded */
  success: boolean;
  /** Session ID if created successfully */
  sessionId?: string;
  /** Error message if creation failed */
  error?: string;
}

/**
 * Generic voice-tool RPC: a mobile voice agent asks the desktop to run a
 * voice-enabled tool (e.g. the Nimbalyst Memory extension's
 * search_project_knowledge / recall / remember) and return the result.
 * Sent via index WebSocket, processed by desktop. The desktop gates execution
 * to tools flagged voiceAgent:true. toolName/args/result are E2E-encrypted on
 * the wire (they carry project knowledge).
 */
export interface VoiceToolRequest {
  /** Unique request ID for correlation */
  requestId: string;
  /** Project/workspace this call targets */
  projectId: string;
  /** Tool name (realtime-safe, e.g. "search_project_knowledge") */
  toolName: string;
  /** JSON-stringified tool arguments */
  argsJson: string;
  /** Timestamp when request was created */
  timestamp: number;
}

/**
 * Response to a voice-tool request. Sent by desktop after the tool runs.
 */
export interface VoiceToolResponse {
  /** Request ID this is responding to */
  requestId: string;
  /** Whether the tool ran successfully */
  success: boolean;
  /** JSON-stringified tool result (success message / data), if any */
  resultJson?: string;
  /** Error message if the tool failed or was not permitted */
  error?: string;
}

/**
 * Request to create a new git worktree from mobile.
 * Sent via index WebSocket, processed by desktop.
 */
export interface CreateWorktreeRequest {
  /** Unique request ID for tracking */
  requestId: string;
  /** Project/workspace ID to create the worktree in */
  projectId: string;
  /** Timestamp when request was created */
  timestamp: number;
}

/**
 * Response to a create worktree request.
 * Sent by desktop after worktree is created.
 */
export interface CreateWorktreeResponse {
  /** Request ID this is responding to */
  requestId: string;
  /** Whether worktree creation succeeded */
  success: boolean;
  /** Error message if creation failed */
  error?: string;
}

/**
 * Generic session control message.
 * The sync layer just passes these through - interpretation is up to the receiver.
 */
export interface SessionControlMessage {
  /** Session ID this message is for */
  sessionId: string;
  /** Message type - receiver decides how to handle */
  type: string;
  /** Arbitrary payload - receiver interprets based on type */
  payload?: Record<string, unknown>;
  /** Timestamp when message was sent */
  timestamp: number;
  /** Device that sent the message */
  sentBy: 'desktop' | 'mobile';
}

/**
 * Voice mode settings synced from desktop.
 */
export interface SyncedVoiceModeSettings {
  /** Which voice to use (OpenAI Realtime API voices) */
  voice?: 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';
  /** Delay before auto-submitting voice commands (ms) */
  submitDelayMs?: number;
}

/**
 * Settings that can be synced from desktop to mobile.
 * These are sensitive settings that should be encrypted in transit.
 */
export interface SyncedSettings {
  /** OpenAI API key for voice transcription */
  openaiApiKey?: string;
  /** Voice mode settings */
  voiceMode?: SyncedVoiceModeSettings;
  /** Available AI models from desktop, for mobile model picker */
  availableModels?: SyncedAvailableModel[];
  /** Desktop's default model ID (e.g., "claude-code:opus") */
  defaultModel?: string;
  /** Whether the desktop "meta-agent" alpha feature is enabled (gates the mobile Meta Agent UI) */
  metaAgentEnabled?: boolean;
  /**
   * Desktop's preferred agent language (BCP-47 or common language name). The
   * voice agent pins its spoken language to this so mobile never starts up in a
   * different language than the desktop is configured for. Empty/omitted means
   * no preference -> the voice agent falls back to English.
   */
  preferredAgentLanguage?: string;
  /** Version for handling future upgrades */
  version: number;
}

/**
 * An AI model available on the desktop, synced to mobile for the model picker.
 */
export interface SyncedAvailableModel {
  /** Full model ID (e.g., "claude-code:opus", "claude:claude-sonnet-4-20250514") */
  id: string;
  /** Display name (e.g., "Claude Opus 4.6", "Claude Sonnet 4") */
  name: string;
  /** Provider identifier (e.g., "claude-code", "claude", "openai") */
  provider: string;
}

/**
 * Encrypted settings payload for wire transmission.
 */
export interface EncryptedSettingsPayload {
  /** Encrypted JSON blob containing SyncedSettings (base64) */
  encryptedSettings: string;
  /** IV for settings decryption (base64) */
  settingsIv: string;
  /** Device ID of sender */
  deviceId: string;
  /** Timestamp of settings change */
  timestamp: number;
  /** Version to handle upgrades */
  version: number;
}
