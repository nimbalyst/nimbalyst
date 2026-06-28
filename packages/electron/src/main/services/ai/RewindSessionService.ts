/**
 * RewindSessionService -- the single backend primitive behind the
 * "edit a previously-sent message + rewind" feature.
 *
 * Given a target user message, it destructively discards that message and
 * everything after it in the SAME session, (optionally) reverts workspace file
 * changes, resets the provider so the next turn starts cleanly, rebuilds the
 * canonical transcript, and stages a one-shot context prefix so agent providers
 * keep the conversational thread after their session is reset.
 *
 * The renderer then re-sends the edited message text through the normal
 * `ai:sendMessage` path, which becomes the new turn at the rewound position.
 *
 * Covers both user scenarios with one path:
 *  - "stop & fix the last message" (target = last user message, a turn may be running)
 *  - "rewind N turns back and re-run" (target = an earlier user message)
 */

import { BrowserWindow } from 'electron';
import type { SessionManager } from '@nimbalyst/runtime';
import { logger } from '../../utils/logger';

export interface RewindSessionParams {
  sessionId: string;
  /** Raw `ai_agent_messages.id` of the user message to rewind to. */
  targetRawMessageId: number;
  /** When true, also revert workspace file changes made after the target. */
  revertFiles: boolean;
  workspacePath?: string;
}

export interface RewindSessionResult {
  success: boolean;
  /** Number of raw messages discarded at and after the target. */
  deletedCount: number;
  /** Files restored to their as-of-target state (when revertFiles). */
  revertedFiles?: string[];
  /** Files that could not be reverted (no recoverable snapshot). */
  unrevertableFiles?: string[];
  error?: string;
}

export interface RewindImpact {
  /** Messages that would be discarded AFTER the target (the target itself is edited, not discarded). */
  messageCount: number;
  /** Distinct files edited after the target (0 until the file-revert service is wired). */
  fileCount: number;
}

/**
 * File-revert collaborator (implemented in Stage 4). Kept as an interface so the
 * truncation primitive has zero hard dependency on the file machinery and stays
 * unit-testable in isolation.
 */
export interface FileRevertCollaborator {
  revertFilesAfter(params: {
    sessionId: string;
    workspacePath?: string;
    afterMessageId: number;
  }): Promise<{ revertedFiles: string[]; unrevertableFiles: string[] }>;
  countFilesAfter(sessionId: string, afterMessageId: number): Promise<number>;
}

/**
 * Build a bounded, plain-text prefix replaying the earlier conversation so a
 * freshly-reset agent provider keeps the thread. Pure and exported for tests.
 * Returns null when there is no meaningful prior text.
 */
export function buildRewindContextPrefix(
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  maxTurns = 12,
): string | null {
  const clean = turns.filter((t) => t.text && t.text.trim().length > 0);
  if (clean.length === 0) {
    return null;
  }
  const truncated = clean.length > maxTurns;
  const bounded = clean.slice(-maxTurns);
  const lines = bounded.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text.trim()}`);
  const header =
    'For context, here is the earlier conversation in this session. The user rewound to edit ' +
    'a previous message; continue naturally from this history and do not repeat it back.\n\n';
  const omitted = truncated ? '[earlier turns omitted]\n\n' : '';
  return `${header}${omitted}${lines.join('\n\n')}\n\n---\n\n`;
}

export class RewindSessionService {
  private fileRevertService?: FileRevertCollaborator;

  constructor(
    private deps: {
      sessionManager: SessionManager;
      /** AIService's in-memory set of sessions with an in-flight turn. */
      sessionsProcessingQueue: Set<string>;
      /**
       * One-shot, per-session context prefix consumed by MessageStreamingHandler
       * on the next send (shared by reference with AIService).
       */
      pendingRewindContext: Map<string, string>;
    },
  ) {}

  /** Inject the file-revert collaborator (Stage 4). */
  setFileRevertService(service: FileRevertCollaborator): void {
    this.fileRevertService = service;
  }

  /**
   * Read-only preview of how much a rewind to `targetRawMessageId` would discard,
   * so the confirm dialog can show counts before the destructive action. Counts
   * messages strictly AFTER the target -- the target itself is edited, not lost.
   */
  async getRewindImpact(sessionId: string, targetRawMessageId: number): Promise<RewindImpact> {
    const { AgentMessagesRepository } = await import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository');
    const messages = await AgentMessagesRepository.list(sessionId, { includeHidden: true });
    const messageCount = messages.filter((m) => (m.id ?? 0) > targetRawMessageId).length;

    let fileCount = 0;
    if (this.fileRevertService) {
      try {
        fileCount = await this.fileRevertService.countFilesAfter(sessionId, targetRawMessageId);
      } catch (err) {
        logger.main.warn('[RewindSessionService] countFilesAfter failed:', err);
      }
    }

    return { messageCount, fileCount };
  }

  async rewindSession(params: RewindSessionParams): Promise<RewindSessionResult> {
    const { sessionId, targetRawMessageId, revertFiles } = params;

    const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
    const { AgentMessagesRepository } = await import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository');
    const { ProviderFactory } = await import('@nimbalyst/runtime/ai/server/ProviderFactory');
    const { getSessionStateManager } = await import('@nimbalyst/runtime/ai/server/SessionStateManager');
    const { isAgentProvider } = await import('@nimbalyst/runtime/ai/server/types');
    const { TranscriptMigrationRepository } = await import('@nimbalyst/runtime');

    const session = await AISessionsRepository.get(sessionId);
    if (!session) {
      return { success: false, deletedCount: 0, error: `Session ${sessionId} not found` };
    }
    const provider = session.provider as string;
    const workspacePath = params.workspacePath ?? session.workspacePath;

    // 1. Stop any in-flight turn -- we are discarding it. Hard abort (not the
    //    graceful interrupt) because the turn's output is being thrown away.
    await this.stopInFlightTurn(sessionId, provider, ProviderFactory, getSessionStateManager);

    // 2. File revert (optional) runs BEFORE truncation: it relies on the
    //    ai_tool_call_file_edits.message_id > N links that the truncation's FK
    //    cascade will destroy. Files were edited by the assistant/tool turns
    //    AFTER the target user message, so the boundary stays strictly > target.
    let revertedFiles: string[] | undefined;
    let unrevertableFiles: string[] | undefined;
    if (revertFiles) {
      if (this.fileRevertService) {
        try {
          const res = await this.fileRevertService.revertFilesAfter({ sessionId, workspacePath, afterMessageId: targetRawMessageId });
          revertedFiles = res.revertedFiles;
          unrevertableFiles = res.unrevertableFiles;
        } catch (err) {
          logger.main.error('[RewindSessionService] file revert failed:', err);
          unrevertableFiles = ['<file revert failed>'];
        }
      } else {
        logger.main.warn('[RewindSessionService] revertFiles requested but no file-revert service is wired');
      }
    }

    // 3. Destructive truncation, INCLUSIVE of the target. The renderer re-sends
    //    the edited text as a fresh turn that lands at the rewound position, so
    //    the target row is removed (not edited in place). For integer primary
    //    keys, `id > target - 1` is exactly `id >= target`. FK CASCADE clears
    //    ai_tool_call_file_edits and the FTS delete trigger clears the mirror.
    const { deletedIds } = await AgentMessagesRepository.deleteMessagesAfter(sessionId, targetRawMessageId - 1);

    // 4. Reset the provider session. Agent providers (claude-code, codex) own
    //    their conversation history internally and cannot truncate it, so the
    //    next turn must start a FRESH provider session (no stale resume). Clear
    //    BOTH the in-memory provider AND the DB provider_session_id, in that
    //    order, before any next send.
    if (isAgentProvider(provider)) {
      try {
        ProviderFactory.destroyProvider(sessionId);
        await this.deps.sessionManager.updateProviderSessionData(sessionId, undefined);
      } catch (err) {
        logger.main.warn('[RewindSessionService] provider session reset failed:', err);
      }
    }

    // 5. Rebuild the canonical transcript from the now-truncated raw log and
    //    nudge any open renderer view to reload (reusing the existing reparse
    //    signal the renderer already listens for).
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().forceReparseSession(sessionId, provider);
      }
    } catch (err) {
      logger.main.error('[RewindSessionService] forceReparseSession failed:', err);
    }

    // 6. Stage the one-shot context prefix so the fresh agent session keeps the
    //    thread when the renderer re-sends the edited message. Chat providers
    //    replay their full message array each turn and need no prefix.
    this.deps.pendingRewindContext.delete(sessionId);
    if (isAgentProvider(provider)) {
      await this.buildAndStoreContextPrefix(sessionId, provider);
    }

    this.broadcastReparsed(sessionId, workspacePath);

    logger.main.info(
      `[RewindSessionService] rewound session ${sessionId} to message ${targetRawMessageId}: ${deletedIds.length} messages discarded` +
        (revertFiles ? `, ${revertedFiles?.length ?? 0} files reverted` : ''),
    );

    return {
      success: true,
      deletedCount: deletedIds.length,
      revertedFiles,
      unrevertableFiles,
    };
  }

  /**
   * Reconstruct a bounded context prefix from the surviving (pre-target)
   * conversation and stash it for the next send. Uses the same client-side
   * projection the mobile transcript uses, so the replayed text matches what
   * the user saw.
   */
  private async buildAndStoreContextPrefix(sessionId: string, provider: string): Promise<void> {
    try {
      const { AgentMessagesRepository } = await import('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository');
      const { projectRawMessagesToViewMessages } = await import('@nimbalyst/runtime/ai/server/transcript/projectRawMessages');

      const msgs = await AgentMessagesRepository.list(sessionId, { includeHidden: false });
      if (msgs.length === 0) {
        return;
      }
      const raw = msgs.map((m) => ({
        id: m.id ?? 0,
        sessionId,
        source: m.source,
        direction: m.direction,
        content: m.content,
        createdAt: m.createdAt ?? new Date(),
        metadata: m.metadata,
        hidden: m.hidden,
      }));
      const view = await projectRawMessagesToViewMessages(raw, provider);
      const turns = view
        .filter((v) => v.type === 'user_message' || v.type === 'assistant_message')
        .map((v) => ({
          role: (v.type === 'user_message' ? 'user' : 'assistant') as 'user' | 'assistant',
          text: v.text ?? '',
        }));

      const prefix = buildRewindContextPrefix(turns);
      if (prefix) {
        this.deps.pendingRewindContext.set(sessionId, prefix);
      }
    } catch (err) {
      logger.main.warn('[RewindSessionService] context prefix build failed:', err);
    }
  }

  private async stopInFlightTurn(
    sessionId: string,
    provider: string,
    ProviderFactory: typeof import('@nimbalyst/runtime/ai/server/ProviderFactory')['ProviderFactory'],
    getSessionStateManager: typeof import('@nimbalyst/runtime/ai/server/SessionStateManager')['getSessionStateManager'],
  ): Promise<void> {
    this.deps.sessionsProcessingQueue.delete(sessionId);

    try {
      const { getQueuedPromptsStore } = await import('../RepositoryManager');
      const queueStore = getQueuedPromptsStore();
      // Resolve any executing queued prompt cleanly...
      await queueStore.sweepExecutingForSession(sessionId);
      // ...then drop pending/executing prompts -- they were queued against the
      // conversation tail we are discarding.
      const pending = await queueStore.listForSession(sessionId, { includeCompleted: false });
      for (const p of pending) {
        if (p.status === 'pending' || p.status === 'executing') {
          await queueStore.delete(p.id);
        }
      }
    } catch (err) {
      logger.main.warn('[RewindSessionService] queued-prompt cleanup failed:', err);
    }

    try {
      const providerInstance = ProviderFactory.getProvider(provider as Parameters<typeof ProviderFactory.getProvider>[0], sessionId);
      providerInstance?.abort();
    } catch (err) {
      logger.main.warn('[RewindSessionService] provider abort failed:', err);
    }

    try {
      await getSessionStateManager().endSession(sessionId);
    } catch {
      // Session may not be active -- fine.
    }
  }

  private broadcastReparsed(sessionId: string, workspacePath?: string): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('transcript:session-reparsed', { sessionId, workspacePath });
      }
    }
  }
}
