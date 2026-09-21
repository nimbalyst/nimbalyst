import type { SyncedQueuedPrompt, SyncedSessionMetadata } from './types';

/** Local queue removals must survive older index pages and broadcasts. */
export function createSessionQueueReconciler() {
  const removed = new Map<string, Set<string>>();
  return {
    record(sessionId: string, previous: SyncedQueuedPrompt[] | undefined, next: SyncedQueuedPrompt[]) {
      const ids = removed.get(sessionId) ?? new Set<string>();
      const pending = new Set(next.map(prompt => prompt.id));
      for (const prompt of previous ?? []) {
        if (!pending.has(prompt.id)) ids.add(prompt.id);
      }
      // A deliberate rollback to pending is allowed to queue the same ID again.
      for (const id of pending) ids.delete(id);
      if (ids.size) removed.set(sessionId, ids);
      else removed.delete(sessionId);
    },
    merge(entry: CachedSessionIndex): CachedSessionIndex {
      const ids = removed.get(entry.sessionId);
      if (!ids || !entry.queuedPrompts?.some(prompt => ids.has(prompt.id))) return entry;
      const queuedPrompts = entry.queuedPrompts.filter(prompt => !ids.has(prompt.id));
      return { ...entry, queuedPrompts, queuedPromptCount: queuedPrompts.length };
    },
    delete(sessionId: string) { removed.delete(sessionId); },
  };
}

// Cache of session index entries for partial update merging
// This cache stores DECRYPTED values locally
export interface CachedSessionIndex {
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
  queuedPrompts?: SyncedQueuedPrompt[];
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

/** Merge intent only when its serialized publication starts, never before enqueueing. */
export function mergeSessionIndexMetadata(
  cached: CachedSessionIndex,
  meta: Partial<SyncedSessionMetadata>,
): CachedSessionIndex {
  const updatedAt = meta.updatedAt;
  return {
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
}
