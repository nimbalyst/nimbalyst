/**
 * Pure core for flushing the next queued prompt into a `claude-code-cli` session
 * (NIM-806 — input integration / queued prompts).
 *
 * The SDK path flushes its queue via `ai:triggerQueueProcessing` → the in-process
 * send loop. The CLI has no such loop — it's driven by the PTY — so when a CLI
 * turn ends (the PID watcher's authoritative `idle` transition), we claim the
 * oldest pending prompt and submit it to the PTY via the shared
 * `submitClaudeCliPrompt` composer (so its attachments flush identically to an
 * immediate send). Writing the prompt restarts the CLI (idle → running → idle),
 * and the next idle flushes the following prompt, so the queue drains one prompt
 * per turn with no extra scheduling.
 *
 * Kept dependency-free (store/submit injected) so it unit-tests without pulling
 * in electron/RepositoryManager. Production wiring lives in
 * `claudeCliQueueFlushSingleton.ts`.
 */

import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import type { ClaudeCliDocumentContext } from './claudeCliPromptComposer';

export interface FlushQueuedPrompt {
  id: string;
  prompt?: string | null;
  attachments?: unknown[] | null;
  /** Active-doc/selection context captured at queue time (NIM-818). */
  documentContext?: ClaudeCliDocumentContext | null;
}

export interface FlushClaudeCliQueueDeps {
  listPending: (sessionId: string) => Promise<FlushQueuedPrompt[]>;
  claim: (promptId: string) => Promise<FlushQueuedPrompt | null>;
  complete: (promptId: string) => Promise<void>;
  fail: (promptId: string, errorMessage: string) => Promise<void>;
  submit: (input: {
    sessionId: string;
    workspacePath: string;
    prompt: string;
    attachments?: ChatAttachment[];
    documentContext?: ClaudeCliDocumentContext | null;
  }) => Promise<{ submitted: boolean }>;
  /**
   * Tell the renderer a queued prompt has left the pending queue, so it drops
   * the row from the queued-prompts UI (NIM-830). Mirrors the SDK dispatcher's
   * `ai:promptClaimed`. Fired right after a successful claim.
   */
  notifyClaimed?: (promptId: string) => void;
}

/**
 * Claim + submit the oldest pending queued prompt for the session. Returns true
 * iff a prompt was claimed and written to the PTY. Marks the prompt completed on
 * success, failed on error (so it doesn't get stuck in `executing`).
 */
export async function flushNextClaudeCliQueuedPrompt(
  args: { sessionId: string; workspacePath: string },
  deps: FlushClaudeCliQueueDeps,
): Promise<boolean> {
  const pending = await deps.listPending(args.sessionId);
  if (pending.length === 0) return false;

  const claimed = await deps.claim(pending[0].id);
  if (!claimed) return false;

  deps.notifyClaimed?.(claimed.id);

  try {
    const { submitted } = await deps.submit({
      sessionId: args.sessionId,
      workspacePath: args.workspacePath,
      prompt: claimed.prompt ?? '',
      attachments: (claimed.attachments as ChatAttachment[] | undefined) ?? undefined,
      documentContext: claimed.documentContext ?? undefined,
    });
    await deps.complete(claimed.id);
    return submitted;
  } catch (error) {
    await deps.fail(claimed.id, error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}
