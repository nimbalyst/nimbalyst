import type { AgentRole, SessionData, SessionMode, SessionType, TranscriptViewMessage } from '../server/types';

// Type aliases for compatibility
export type ChatMessage = TranscriptViewMessage;
export type ChatSession = SessionData;

/**
 * Canonical session metadata type used across all layers (data, IPC, UI).
 * This is the single source of truth for session list/registry items.
 */
export interface SessionMeta {
  id: string;
  title: string;
  provider: string;
  model?: string;
  sessionType: SessionType;
  mode?: SessionMode;
  agentRole?: AgentRole;
  createdBySessionId?: string | null;
  workspaceId: string;
  worktreeId: string | null;
  parentSessionId: string | null;
  childCount: number;
  uncommittedCount: number;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  isArchived: boolean;
  isPinned: boolean;
  hasUnread?: boolean;
  /**
   * Authoritative pending-interactive-prompt bit, persisted in
   * `ai_sessions.metadata.hasPendingPrompt` and synced across devices.
   * Set/cleared by the main-process prompt handlers on every open/resolve.
   * Renderer mirrors into `sessionHasPendingInteractivePromptAtom` on
   * session list refresh so a stale in-memory atom gets corrected.
   */
  hasPendingInteractivePrompt?: boolean;
  // Kanban board phase and tags (from metadata JSONB)
  phase?: string;
  tags?: string[];
  // Linked tracker item IDs (from metadata JSONB)
  linkedTrackerItemIds?: string[];
  // Branch tracking - SEPARATE from hierarchical parentSessionId
  branchedFromSessionId?: string;
  branchPointMessageId?: number;
  branchedAt?: number;
}

/** @deprecated Use SessionMeta */
export type SessionListItem = SessionMeta;

export interface CreateSessionPayload {
  id: string;
  provider: string;
  model?: string;
  sessionType?: SessionType;
  mode?: SessionMode;
  agentRole?: AgentRole;
  createdBySessionId?: string | null;
  title?: string;
  workspaceId: string;
  filePath?: string;
  worktreeId?: string;  // ID of the associated worktree
  worktreePath?: string;  // Path to the worktree directory
  worktreeProjectPath?: string;  // Path to the parent project (for permission lookups)
  parentSessionId?: string | null;  // Parent session ID for hierarchical workstreams
  providerConfig?: Record<string, unknown>;
  providerSessionId?: string;
  documentContext?: Record<string, unknown> | undefined;
  createdAt?: number; // Optional override for imported sessions
  updatedAt?: number; // Optional override for imported sessions
  // Branch tracking - SEPARATE from hierarchical parentSessionId
  branchedFromSessionId?: string;  // ID of the session this was forked from
  branchPointMessageId?: number;  // Message ID where this branch diverged
  branchedAt?: number;  // Timestamp when the branch was created
}

/**
 * Persisted document state for DocumentContextService.
 * Stored per-session to enable transition detection across app restarts.
 * Note: content is NOT stored - only hash. First message after restart
 * will use full content (no diff) if hash differs from current file.
 */
export interface PersistedDocumentState {
  filePath: string;
  contentHash: string;
}

export interface UpdateSessionMetadataPayload extends Partial<CreateSessionPayload> {
  draftInput?: string;
  metadata?: Record<string, unknown>;
  isArchived?: boolean;
  /** Document state for transition detection (persisted across restarts) */
  lastDocumentState?: PersistedDocumentState | null;
  /** Canonical transcript transform tracking */
  canonicalTransformVersion?: number | null;
  canonicalTransformStatus?: 'pending' | 'complete' | 'error' | null;
  canonicalLastTransformedAt?: Date | null;
  canonicalLastRawMessageId?: number | null;
}

export interface SessionListOptions {
  includeArchived?: boolean;
}

export interface SessionSearchOptions extends SessionListOptions {
  timeRange?: '7d' | '30d' | '90d' | 'all';
  direction?: 'all' | 'input' | 'output';
}

export interface SessionStore {
  ensureReady(): Promise<void>;
  create(payload: CreateSessionPayload): Promise<void>;
  updateMetadata(sessionId: string, metadata: UpdateSessionMetadataPayload): Promise<void>;
  get(sessionId: string): Promise<SessionData | null>;
  /**
   * Batch fetch multiple sessions by IDs.
   * More efficient than calling get() multiple times.
   * Returns sessions in arbitrary order (not necessarily matching input order).
   */
  getMany?(sessionIds: string[]): Promise<SessionData[]>;
  list(workspaceId: string, options?: SessionListOptions): Promise<SessionMeta[]>;
  search(workspaceId: string, query: string, options?: SessionSearchOptions): Promise<SessionMeta[]>;
  delete(sessionId: string): Promise<void>;
  /**
   * Atomically update session title if it has not been named yet.
   * Returns true if the update succeeded, false if the session was already named.
   */
  updateTitleIfNotNamed?(sessionId: string, title: string): Promise<boolean>;
  /**
   * Get all branches for a given session.
   * Returns sessions that have this session as their parent.
   */
  getBranches?(sessionId: string): Promise<SessionMeta[]>;
}

let activeSessionStore: SessionStore | null = null;

export function setSessionStore(store: SessionStore | null): void {
  activeSessionStore = store;
}

export function hasSessionStore(): boolean {
  return activeSessionStore !== null;
}

export function getSessionStore(): SessionStore {
  if (!activeSessionStore) {
    throw new Error('Session store adapter has not been configured');
  }
  return activeSessionStore;
}
