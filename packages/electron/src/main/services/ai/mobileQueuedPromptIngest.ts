/**
 * Ingests queued prompts that arrived on a session's sync index entry from
 * another device (the phone).
 *
 * Why this is its own module (#1193): this is the only queue-mutation path that
 * never published the resulting pending queue back to sync. The phone does not
 * insert a local row when it sends a prompt — it only pushes an index entry —
 * and the index room excludes the sender from its own broadcast, so the desktop
 * is the only thing that can tell the phone "you are authoritatively queued."
 * Without that push the queue pane stayed empty for the entire pending window,
 * and the first push the phone ever saw was the empty list published at claim
 * time. Extracting the block gives it a test seam; it used to be an inline
 * closure inside AIService.tryInitializeMobileSyncHandler.
 */

import type { CreateQueuedPromptInput } from '../PGLiteQueuedPromptsStore';
import { createKeyedSerialQueue } from '@nimbalyst/runtime/sync/indexPublication';

// Multiple windows register listeners on the same provider. Serialize their
// dedupe/insert/publish work so they cannot race to insert the same mobile ID.
const ingestionQueue = createKeyedSerialQueue();

export interface IncomingQueuedPrompt {
  id: string;
  prompt: string;
  attachments?: any[];
}

export interface MobileQueuedPromptIngestDeps {
  /** Existing row for this id, whatever its status — used to dedupe sync replays. */
  getExisting(promptId: string): Promise<{ status: string } | null>;
  createPrompt(input: CreateQueuedPromptInput): Promise<unknown>;
  /** Mirror the session's still-pending rows back onto the sync index. */
  publishQueueState(sessionId: string): Promise<void>;
  getSession(sessionId: string): Promise<{ provider?: string; workspacePath?: string } | null>;
  trackQueued(provider: string | undefined): void;
  /** Tell an already-open window so its queue list updates now. */
  notifyWindow(params: { sessionId: string; promptCount: number; workspacePath: string }): void;
  requestDrive(sessionId: string, workspacePath: string): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
  logError(message: string, error?: unknown): void;
}

/**
 * Returns how many prompts were newly inserted. Never throws — a failure here
 * must not take down the sync listener.
 */
export async function ingestMobileQueuedPrompts(
  deps: MobileQueuedPromptIngestDeps,
  sessionId: string,
  prompts: IncomingQueuedPrompt[],
): Promise<number> {
  return ingestionQueue.run(sessionId, () => ingestQueuedPrompts(deps, sessionId, prompts));
}

async function ingestQueuedPrompts(
  deps: MobileQueuedPromptIngestDeps,
  sessionId: string,
  prompts: IncomingQueuedPrompt[],
): Promise<number> {
  if (prompts.length === 0) return 0;

  deps.logInfo(
    `[AIService] Received queuedPrompts from mobile via onIndexChange: ${JSON.stringify({
      sessionId,
      count: prompts.length,
      promptIds: prompts.map((p) => p.id),
    })}`,
  );

  try {
    let newPromptsCount = 0;
    let hasConsumedReplay = false;
    for (const prompt of prompts) {
      // Rows are status-transitioned, never deleted, so this also stops a late
      // replay from resurrecting a prompt that already ran.
      const existing = await deps.getExisting(prompt.id);
      if (existing) {
        if (existing.status !== 'pending') hasConsumedReplay = true;
        continue;
      }
      // Unknown desktop prompts belong to their originating desktop.
      if (prompt.id.startsWith('local-')) continue;

      await deps.createPrompt({
        id: prompt.id,
        sessionId,
        prompt: prompt.prompt,
        attachments: prompt.attachments,
        documentContext: {
          promptProvenance: {
            actor: 'human',
            origin: 'mobile',
            queuedPromptId: prompt.id,
          },
        },
      });
      newPromptsCount++;
    }

    if (newPromptsCount === 0) {
      // Dedupe prevents execution, but must also repair the queue the phone sees.
      if (hasConsumedReplay) await deps.publishQueueState(sessionId);
      return 0;
    }

    deps.logInfo(`[AIService] Inserted ${newPromptsCount} new prompts into queued_prompts table`);

    // Before anything that can claim: a claim publishes the emptied queue, and
    // a snapshot taken here but sent after that would re-assert a prompt the
    // desktop already started running.
    await deps.publishQueueState(sessionId);

    const session = await deps.getSession(sessionId);
    if (!session) {
      deps.logWarn(`[AIService] Session not found for queuedPrompts: ${sessionId}`);
      return newPromptsCount;
    }

    // Mobile doesn't currently support attachments or documentContext.
    for (let i = 0; i < newPromptsCount; i++) {
      deps.trackQueued(session.provider);
    }

    if (!session.workspacePath) {
      // Sessions MUST have a workspacePath. Do NOT fall back to windows[0] —
      // that masks the real data-integrity bug.
      deps.logError(
        `[AIService] Session has no workspacePath - cannot route queued prompts. SessionId: ${sessionId}`,
      );
      return newPromptsCount;
    }

    deps.notifyWindow({ sessionId, promptCount: newPromptsCount, workspacePath: session.workspacePath });

    // Opening a window (when there isn't one) and actually dispatching are the
    // driver's job — it owns the retry when the workspace is closed or the
    // session is mid-turn (#962).
    deps.requestDrive(sessionId, session.workspacePath);

    return newPromptsCount;
  } catch (err) {
    deps.logError('[AIService] Failed to insert queuedPrompts into table:', err);
    return 0;
  }
}
