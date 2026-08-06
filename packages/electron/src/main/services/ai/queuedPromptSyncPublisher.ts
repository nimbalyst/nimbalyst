/**
 * Mirrors the desktop's pending queue into the sync index after every queue
 * transition.
 *
 * Why this exists (NIM-2402): iOS publishes a queued prompt into its index
 * entry, the desktop receives it and caches `queuedPrompts` in CollabV3Sync's
 * `sessionIndexCache`, then every later bulk sync pass re-encrypts and
 * re-publishes that same cached prompt. iOS's `replaceQueuedPrompts` keeps
 * re-inserting the row, so the "N QUEUED" chip survives long after the prompt
 * has been claimed and run. CollabV3Sync has propagated an explicitly-empty
 * queue since #817 — it just never had a caller.
 *
 * Only `pending` rows are published: a claimed row is already visible in the
 * transcript, so listing it as queued double-reports the same prompt.
 */

import type { SyncedQueuedPrompt } from '@nimbalyst/runtime/sync';

export interface QueuedPromptSyncDeps {
  /** The session's still-pending rows, oldest first. */
  listPending(sessionId: string): Promise<Array<{ id: string; prompt: string; createdAt: number }>>;
  getSyncProvider(): { pushChange?: (sessionId: string, change: any) => void } | null;
  logWarn(message: string): void;
}

/**
 * Returns the published snapshot, or null when the publish was skipped
 * (sync unavailable) or failed. Never throws — a sync side-channel must not
 * break claiming, completing, or cancelling a prompt.
 */
export async function publishQueuedPromptsToSync(
  deps: QueuedPromptSyncDeps,
  sessionId: string,
): Promise<SyncedQueuedPrompt[] | null> {
  const syncProvider = deps.getSyncProvider();
  if (!syncProvider?.pushChange) {
    return null;
  }

  try {
    const pending = await deps.listPending(sessionId);
    // Attachments are deliberately dropped: the desktop's local rows hold
    // file paths, not the encrypted mobile payload, and no consumer reads
    // them back off a re-published entry.
    const queuedPrompts: SyncedQueuedPrompt[] = pending.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      timestamp: row.createdAt,
    }));

    // No `updatedAt`: draining the queue must not resort the mobile session list.
    syncProvider.pushChange(sessionId, {
      type: 'metadata_updated',
      metadata: { queuedPrompts },
    });

    return queuedPrompts;
  } catch (error) {
    deps.logWarn(
      `[AIService] failed to publish queued prompts for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
