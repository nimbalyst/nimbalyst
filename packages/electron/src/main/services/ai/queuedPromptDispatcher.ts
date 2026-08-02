import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import type { QueueSettlementResult } from '../PGLiteQueuedPromptsStore';

export type SessionPromptDispatchPreflight = (sessionId: string) => Promise<boolean>;

interface SessionWithDispatchMetadata {
  metadata?: unknown;
}

/**
 * Build the single fail-closed gate used by every queued-prompt admission rail.
 * A missing/unreadable session or malformed metadata is not safe to dispatch;
 * legacy sessions with no metadata remain eligible.
 */
export function createSessionPromptDispatchPreflight(
  loadSession: (sessionId: string) => Promise<SessionWithDispatchMetadata | null>,
): SessionPromptDispatchPreflight {
  return async (sessionId: string): Promise<boolean> => {
    try {
      const session = await loadSession(sessionId);
      if (!session) return false;

      let metadata = session.metadata;
      if (metadata === null || metadata === undefined) return true;
      if (typeof metadata === 'string') {
        try {
          metadata = JSON.parse(metadata) as unknown;
        } catch {
          return false;
        }
      }
      if (typeof metadata !== 'object' || Array.isArray(metadata)) return false;

      return (metadata as Record<string, unknown>).modelChangeReconciliation == null;
    } catch {
      return false;
    }
  };
}

/** Production repository-backed gate shared by SDK, CLI, startup, and IPC rails. */
export const preflightSessionPromptDispatch = createSessionPromptDispatchPreflight(
  (sessionId) => AISessionsRepository.get(sessionId),
);

export interface ClaimedQueuedPrompt {
  id: string;
  prompt: string;
  claimToken?: string;
  attachments?: unknown[] | null;
  documentContext?: DocumentContext | null;
}

export interface QueuedPromptStoreLike {
  listPending(sessionId: string): Promise<ClaimedQueuedPrompt[]>;
  claim(promptId: string, expectedSessionId: string): Promise<ClaimedQueuedPrompt | null>;
  beginDispatch(promptId: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;
  releaseClaim(promptId: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;
  completeAfterDispatch(
    promptId: string,
    expectedSessionId: string,
    claimToken: string,
  ): Promise<QueueSettlementResult>;
  failAfterDispatch(
    promptId: string,
    errorMessage: string,
    expectedSessionId: string,
    claimToken: string,
  ): Promise<QueueSettlementResult>;
}

const settlementAccepted = (result: QueueSettlementResult): boolean =>
  result.outcome === 'settled' || result.outcome === 'idempotent_same_claim';

interface DispatchClaimedQueuedPromptOptions {
  claimed: ClaimedQueuedPrompt;
  continueQueuedPromptChain: (
    sessionId: string,
    workspacePath: string,
    targetWindow: Electron.BrowserWindow,
    source: string,
  ) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  onAfterSettled?: () => Promise<void>;
  onChainSettled?: (payload: { sessionId: string; workspacePath: string; source: string }) => Promise<void>;
  onPromptClaimed: (payload: { sessionId: string; promptId: string }) => void;
  processingLeases: Map<string, symbol>;
  queueStore: QueuedPromptStoreLike;
  sendMessageHandler: (
    event: Electron.IpcMainInvokeEvent,
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    workspacePath?: string,
  ) => Promise<{ content: string }>;
  sessionId: string;
  source: string;
  startSession: (options: { sessionId: string; workspacePath: string }) => Promise<void>;
  targetWindow: Electron.BrowserWindow;
  workspacePath: string;
}

export async function dispatchClaimedQueuedPrompt(
  options: DispatchClaimedQueuedPromptOptions,
): Promise<void> {
  const {
    claimed,
    continueQueuedPromptChain,
    logError,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingLeases,
    queueStore,
    sendMessageHandler,
    sessionId,
    source,
    startSession,
    targetWindow,
    workspacePath,
  } = options;

  const dispatchLease = Symbol(`queued-prompt:${sessionId}:${claimed.id}`);
  const claimToken = claimed.claimToken;
  if (!claimToken) {
    throw new Error(`Queued prompt ${claimed.id} was claimed without an ownership token`);
  }
  processingLeases.set(sessionId, dispatchLease);

  try {
    await startSession({ sessionId, workspacePath });
  } catch (error) {
    const release = await queueStore.releaseClaim(claimed.id, sessionId, claimToken);
    if (!settlementAccepted(release)) {
      logError(
        `[AIService] Failed to release pre-dispatch claim ${claimed.id} (${release.outcome})`,
        error,
      );
    }
    if (processingLeases.get(sessionId) === dispatchLease) {
      processingLeases.delete(sessionId);
    }
    throw error;
  }

  try {
    onPromptClaimed({ sessionId, promptId: claimed.id });
  } catch (notificationError) {
    logError(`[AIService] Failed to notify renderer of claimed prompt ${claimed.id}:`, notificationError);
  }

  const docContext = {
    ...(claimed.documentContext || {}),
    queuedPromptId: claimed.id,
    attachments: claimed.attachments,
  } as DocumentContext;

  setImmediate(async () => {
    let dispatchStarted = false;
    let compatibleSettlement = false;
    try {
      if (processingLeases.get(sessionId) !== dispatchLease) return;
      const begin = await queueStore.beginDispatch(claimed.id, sessionId, claimToken);
      if (!settlementAccepted(begin)) {
        logError(
          `[AIService] Dispatch intent rejected for queued prompt ${claimed.id} (${begin.outcome})`,
          new Error(begin.outcome),
        );
        return;
      }
      dispatchStarted = true;
      if (processingLeases.get(sessionId) !== dispatchLease) return;

      const mockEvent = {
        sender: targetWindow.webContents,
        senderFrame: targetWindow.webContents.mainFrame,
      } as Electron.IpcMainInvokeEvent;

      await sendMessageHandler(mockEvent, claimed.prompt, docContext, sessionId, workspacePath);
      const completion = await queueStore.completeAfterDispatch(claimed.id, sessionId, claimToken);
      compatibleSettlement = settlementAccepted(completion);
      if (!compatibleSettlement) {
        logError(
          `[AIService] Completion rejected for queued prompt ${claimed.id} (${completion.outcome})`,
          new Error(completion.outcome),
        );
      }
    } catch (queueError) {
      logError(`[AIService] Failed to process queued prompt ${claimed.id}:`, queueError);
      const settlement = dispatchStarted
        ? await queueStore.failAfterDispatch(
            claimed.id,
            queueError instanceof Error ? queueError.message : 'Unknown error',
            sessionId,
            claimToken,
          )
        : await queueStore.releaseClaim(claimed.id, sessionId, claimToken);
      compatibleSettlement = settlementAccepted(settlement);
      if (!compatibleSettlement) {
        logError(
          `[AIService] Failure settlement rejected for queued prompt ${claimed.id} (${settlement.outcome})`,
          queueError,
        );
      }
    } finally {
      // An interrupt revokes this dispatch's lease before a priority prompt
      // acquires a replacement. The interrupted dispatch can settle later, but
      // its stale finally block must not release the replacement lease or
      // continue the ordinary FIFO chain concurrently with priority delivery.
      if (processingLeases.get(sessionId) !== dispatchLease) {
        return;
      }
      processingLeases.delete(sessionId);
      if (!compatibleSettlement) return;
      try {
        await continueQueuedPromptChain(
          sessionId,
          workspacePath,
          targetWindow,
          `${source} finally`,
        );
      } catch (chainErr) {
        logError(`[AIService] ${source} finally: error checking for pending prompts:`, chainErr);
      }
      // If no follow-on prompt was dispatched, the chain has fully settled.
      // The inner sendMessage's completion handler deferred endSession because
      // processingLeases still contained this session (we hadn't reached this
      // delete yet), so nobody has marked the session idle. Do it now.
      if (!processingLeases.has(sessionId) && onChainSettled) {
        try {
          await onChainSettled({ sessionId, workspacePath, source });
        } catch (settledErr) {
          logError(`[AIService] ${source} finally: chain-settled hook failed:`, settledErr);
        }
      }
      if (onAfterSettled) {
        try {
          await onAfterSettled();
        } catch (afterErr) {
          logError(`[AIService] ${source} finally: post-settle hook failed:`, afterErr);
        }
      }
    }
  });
}

interface TryClaimAndDispatchNextQueuedPromptOptions {
  continueQueuedPromptChain: DispatchClaimedQueuedPromptOptions['continueQueuedPromptChain'];
  logError: DispatchClaimedQueuedPromptOptions['logError'];
  logInfo: (message: string) => void;
  onAfterSettled?: DispatchClaimedQueuedPromptOptions['onAfterSettled'];
  onChainSettled?: DispatchClaimedQueuedPromptOptions['onChainSettled'];
  onPromptClaimed: DispatchClaimedQueuedPromptOptions['onPromptClaimed'];
  processingLeases: Map<string, symbol>;
  preflight: SessionPromptDispatchPreflight;
  queueStore: QueuedPromptStoreLike;
  sendMessageHandler: DispatchClaimedQueuedPromptOptions['sendMessageHandler'] | null;
  sessionId: string;
  source: string;
  startSession: DispatchClaimedQueuedPromptOptions['startSession'];
  resolveLiveWindow?: (workspacePath: string) => Electron.BrowserWindow | null;
  targetWindow: Electron.BrowserWindow | null;
  workspacePath: string;
}

export async function tryClaimAndDispatchNextQueuedPrompt(
  options: TryClaimAndDispatchNextQueuedPromptOptions,
): Promise<boolean> {
  const {
    continueQueuedPromptChain,
    logError,
    logInfo,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingLeases,
    preflight,
    queueStore,
    sendMessageHandler,
    sessionId,
    source,
    startSession,
    resolveLiveWindow,
    targetWindow,
    workspacePath,
  } = options;

  const liveWindow =
    targetWindow && !targetWindow.isDestroyed()
      ? targetWindow
      : resolveLiveWindow?.(workspacePath) ?? null;

  if (!liveWindow || liveWindow.isDestroyed()) {
    logInfo(`[AIService] ${source}: no live window available to continue queued prompts for session ${sessionId}`);
    return false;
  }

  if (processingLeases.has(sessionId)) {
    logInfo(`[AIService] ${source}: session ${sessionId} already processing a queued prompt, skipping`);
    return false;
  }

  if (!(await preflight(sessionId))) {
    logInfo(`[AIService] ${source}: durable model reconciliation blocks queued dispatch for session ${sessionId}`);
    return false;
  }

  const pendingPrompts = await queueStore.listPending(sessionId);
  if (pendingPrompts.length === 0) {
    logInfo(`[AIService] ${source}: no pending prompts for session ${sessionId}`);
    return false;
  }

  const nextPrompt = pendingPrompts[0];
  logInfo(`[AIService] ${source}: processing prompt ${nextPrompt.id} for session ${sessionId}`);

  // The store performs recovery admission and queue reservation in one UPDATE.
  // This is the final dispatch boundary: a marker installed after listPending
  // cannot race between a repository preflight and row ownership.
  const claimed = await queueStore.claim(nextPrompt.id, sessionId);
  if (!claimed) {
    logInfo(`[AIService] ${source}: prompt ${nextPrompt.id} already claimed`);
    return false;
  }

  if (!sendMessageHandler) {
    if (!claimed.claimToken) {
      throw new Error(`Queued prompt ${claimed.id} was claimed without an ownership token`);
    }
    const release = await queueStore.releaseClaim(claimed.id, sessionId, claimed.claimToken);
    if (!settlementAccepted(release)) {
      logError(
        `[AIService] Failed to release uninitialized-handler claim ${claimed.id} (${release.outcome})`,
        new Error(release.outcome),
      );
    }
    logError('[AIService] Failed to process queued prompt because sendMessageHandler is not initialized', new Error('sendMessageHandler not initialized'));
    return false;
  }

  await dispatchClaimedQueuedPrompt({
    claimed,
    continueQueuedPromptChain,
    logError,
    onAfterSettled,
    onChainSettled,
    onPromptClaimed,
    processingLeases,
    queueStore,
    sendMessageHandler,
    sessionId,
    source,
    startSession,
    targetWindow: liveWindow,
    workspacePath,
  });

  return true;
}
