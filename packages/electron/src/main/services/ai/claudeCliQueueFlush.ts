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
import type { QueueSettlementResult } from '../PGLiteQueuedPromptsStore';
import type { SessionPromptDispatchPreflight } from './queuedPromptDispatcher';
import type { ClaudeCliDocumentContext } from './claudeCliPromptComposer';

export interface FlushQueuedPrompt {
  id: string;
  claimToken?: string;
  prompt?: string | null;
  attachments?: unknown[] | null;
  /** Active-doc/selection context captured at queue time (NIM-818). */
  documentContext?: ClaudeCliDocumentContext | null;
}

export interface FlushClaudeCliQueueDeps {
  preflight: SessionPromptDispatchPreflight;
  listPending: (sessionId: string) => Promise<FlushQueuedPrompt[]>;
  claim: (promptId: string, expectedSessionId: string) => Promise<FlushQueuedPrompt | null>;
  beginDispatch: (promptId: string, expectedSessionId: string, claimToken: string) => Promise<QueueSettlementResult>;
  completeAfterDispatch: (promptId: string, expectedSessionId: string, claimToken: string) => Promise<QueueSettlementResult>;
  failAfterDispatch: (promptId: string, errorMessage: string, expectedSessionId: string, claimToken: string) => Promise<QueueSettlementResult>;
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

const settlementAccepted = (result: QueueSettlementResult) =>
  result.outcome === 'settled' || result.outcome === 'idempotent_same_claim';

class QueueSettlementRejectedError extends Error {}

/**
 * Claim + submit the oldest pending queued prompt for the session. Returns true
 * iff a prompt was claimed and written to the PTY. Marks the prompt completed on
 * success, failed on error (so it doesn't get stuck in `executing`).
 */
export async function flushNextClaudeCliQueuedPrompt(
  args: { sessionId: string; workspacePath: string },
  deps: FlushClaudeCliQueueDeps,
): Promise<boolean> {
  if (!(await deps.preflight(args.sessionId))) return false;
  const pending = await deps.listPending(args.sessionId);
  if (pending.length === 0) return false;

  const claimed = await deps.claim(pending[0].id, args.sessionId);
  if (!claimed) return false;
  if (!claimed.claimToken) throw new Error(`Queued prompt ${claimed.id} was claimed without an ownership token`);
  const claimToken = claimed.claimToken;

  try {
    deps.notifyClaimed?.(claimed.id);
  } catch {
    // Renderer projection is best-effort and never owns durable settlement.
  }

  let dispatchBegun = false;
  try {
    const begun = await deps.beginDispatch(claimed.id, args.sessionId, claimToken);
    if (!settlementAccepted(begun)) {
      throw new QueueSettlementRejectedError(`Queued prompt dispatch intent was rejected: ${begun.outcome}`);
    }
    dispatchBegun = true;

    const prompt = claimed.prompt ?? '';
    const attachments = (claimed.attachments as ChatAttachment[] | undefined) ?? undefined;
    if (!prompt.trim() && (!attachments || attachments.length === 0)) {
      const rejected = await deps.failAfterDispatch(claimed.id, 'Queued CLI prompt had no sendable content', args.sessionId, claimToken);
      if (!settlementAccepted(rejected)) {
        throw new Error(`Queued prompt empty-input settlement was rejected: ${rejected.outcome}`);
      }
      return false;
    }

    const { submitted } = await deps.submit({
      sessionId: args.sessionId,
      workspacePath: args.workspacePath,
      prompt,
      attachments,
      documentContext: claimed.documentContext ?? undefined,
    });
    if (!submitted) {
      const rejected = await deps.failAfterDispatch(claimed.id, 'CLI prompt submission produced no terminal input', args.sessionId, claimToken);
      if (!settlementAccepted(rejected)) {
        throw new Error(`Queued prompt no-op settlement was rejected: ${rejected.outcome}`);
      }
      return false;
    }
    const completed = await deps.completeAfterDispatch(claimed.id, args.sessionId, claimToken);
    if (!settlementAccepted(completed)) {
      throw new QueueSettlementRejectedError(`Queued prompt completion was rejected: ${completed.outcome}`);
    }
    return true;
  } catch (error) {
    if (!dispatchBegun || error instanceof QueueSettlementRejectedError) throw error;
    const failure = await deps.failAfterDispatch(
      claimed.id,
      error instanceof Error ? error.message : 'Unknown error',
      args.sessionId,
      claimToken,
    );
    if (!settlementAccepted(failure)) {
      throw new Error(`Queued prompt failure settlement was rejected: ${failure.outcome}`);
    }
    return false;
  }
}
