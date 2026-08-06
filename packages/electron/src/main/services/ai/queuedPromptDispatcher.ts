import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';
import type { QueueSettlementResult } from '../PGLiteQueuedPromptsStore';
import { payloadReceiptsMatch, queueTruthMismatchError, type QueuedPromptPayloadReceipt } from './queuedPromptTruth';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
export type SessionPromptDispatchPreflight = (sessionId: string) => Promise<boolean>;

interface SessionWithDispatchMetadata {
  metadata?: unknown;
}

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

export const preflightSessionPromptDispatch = createSessionPromptDispatchPreflight(
  (sessionId) => AISessionsRepository.get(sessionId),
);

export interface ClaimedQueuedPrompt {
  id: string;
  prompt: string;
  claimToken?: string;
  attachments?: unknown[] | null;
  documentContext?: DocumentContext | null;
  payloadReceipt?: QueuedPromptPayloadReceipt;
  clientSubmissionId?: string;
  sourceSessionId?: string;
  sourceRoomId?: string;
  submissionSequence?: number;
  producer?: string;
  claimTrigger?: string;
  claimTriggeredAt?: number;
  turnId?: string;
  providerInputMessageId?: string;
  providerOutputMessageId?: string;
}

export interface QueuedPromptStoreLike {
  listPending(sessionId: string): Promise<ClaimedQueuedPrompt[]>;
  claim(promptId: string, expectedSessionId: string, claimTrigger?: string): Promise<ClaimedQueuedPrompt | null>;
  beginDispatch(promptId: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;
  releaseClaim(promptId: string, expectedSessionId: string, claimToken: string): Promise<QueueSettlementResult>;
  completeAfterDispatch(promptId: string, expectedSessionId: string, claimToken: string, terminal?: QueuedPromptTerminalReceipt): Promise<QueueSettlementResult>;
  failAfterDispatch(promptId: string, errorMessage: string, expectedSessionId: string, claimToken: string, terminal?: QueuedPromptTerminalReceipt): Promise<QueueSettlementResult>;
}

export interface QueuedPromptTerminalReceipt {
  lifecycle: 'completed' | 'failed';
  terminalAt: number;
  eventSequence: number;
}

const settlementAccepted = (result: QueueSettlementResult) =>
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
  ) => Promise<{ content: string; queuedPromptTerminal?: QueuedPromptTerminalReceipt }>;
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
      logError(`[AIService] Failed to release pre-dispatch claim ${claimed.id} (${release.outcome})`, error);
    }
    if (processingLeases.get(sessionId) === dispatchLease) processingLeases.delete(sessionId);
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
    // This travels with the persisted input message. It binds the source and
    // terminal-output identities without using timestamps, prompt text, or
    // array position as a proxy.
    queuedPromptTruth: {
      clientSubmissionId: claimed.clientSubmissionId ?? claimed.id,
      queueRowId: claimed.id,
      sourceSessionId: claimed.sourceSessionId ?? sessionId,
      sourceRoomId: claimed.sourceRoomId ?? sessionId,
      submissionSequence: claimed.submissionSequence,
      producer: claimed.producer,
      claimTrigger: claimed.claimTrigger,
      claimTriggeredAt: claimed.claimTriggeredAt,
      turnId: claimed.turnId,
      providerInputMessageId: claimed.providerInputMessageId,
      providerOutputMessageId: claimed.providerOutputMessageId,
      payloadReceipt: claimed.payloadReceipt,
      lifecycle: 'streaming' as const,
    },
  } as DocumentContext;

  setImmediate(async () => {
    let dispatchStarted = false;
    let compatibleSettlement = false;
    try {
      if (processingLeases.get(sessionId) !== dispatchLease) return;
      if (claimed.payloadReceipt && !payloadReceiptsMatch(claimed.prompt, claimed.payloadReceipt)) {
        throw queueTruthMismatchError();
      }
      const begin = await queueStore.beginDispatch(claimed.id, sessionId, claimToken);
      if (!settlementAccepted(begin)) {
        logError(`[AIService] Dispatch intent rejected for queued prompt ${claimed.id} (${begin.outcome})`, new Error(begin.outcome));
        return;
      }
      dispatchStarted = true;
      if (processingLeases.get(sessionId) !== dispatchLease) return;
      const mockEvent = {
        sender: targetWindow.webContents,
        senderFrame: targetWindow.webContents.mainFrame,
      } as Electron.IpcMainInvokeEvent;

      const result = await sendMessageHandler(mockEvent, claimed.prompt, docContext, sessionId, workspacePath);
      const completion = result.queuedPromptTerminal?.lifecycle === 'failed'
        ? await queueStore.failAfterDispatch(
            claimed.id,
            'Provider returned a terminal error',
            sessionId,
            claimToken,
            result.queuedPromptTerminal,
          )
        : result.queuedPromptTerminal
          ? await queueStore.completeAfterDispatch(claimed.id, sessionId, claimToken, result.queuedPromptTerminal)
          : await queueStore.completeAfterDispatch(claimed.id, sessionId, claimToken);
      compatibleSettlement = settlementAccepted(completion);
      if (!compatibleSettlement) {
        logError(`[AIService] Completion rejected for queued prompt ${claimed.id} (${completion.outcome})`, new Error(completion.outcome));
      }
    } catch (queueError) {
      logError(`[AIService] Failed to process queued prompt ${claimed.id}:`, queueError);
      const terminal = (queueError as Error & { queuedPromptTerminal?: QueuedPromptTerminalReceipt }).queuedPromptTerminal;
      const settlement = dispatchStarted
        ? terminal
          ? await queueStore.failAfterDispatch(
              claimed.id,
              queueError instanceof Error ? queueError.message : 'Unknown error',
              sessionId,
              claimToken,
              terminal,
            )
          : await queueStore.failAfterDispatch(
              claimed.id,
              queueError instanceof Error ? queueError.message : 'Unknown error',
              sessionId,
              claimToken,
            )
        : await queueStore.releaseClaim(claimed.id, sessionId, claimToken);
      compatibleSettlement = settlementAccepted(settlement);
      if (!compatibleSettlement) {
        logError(`[AIService] Failure settlement rejected for queued prompt ${claimed.id} (${settlement.outcome})`, queueError);
      }
    } finally {
      if (processingLeases.get(sessionId) !== dispatchLease) return;
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
      // processingSet still contained this session (we hadn't reached this
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
    logInfo(`[AIService] ${source}: session admission preflight rejected ${sessionId}`);
    return false;
  }

  const pendingPrompts = await queueStore.listPending(sessionId);
  if (pendingPrompts.length === 0) {
    logInfo(`[AIService] ${source}: no pending prompts for session ${sessionId}`);
    return false;
  }

  const nextPrompt = pendingPrompts[0];
  logInfo(`[AIService] ${source}: processing prompt ${nextPrompt.id} for session ${sessionId}`);

  const claimed = await queueStore.claim(nextPrompt.id, sessionId, source);
  if (!claimed) {
    logInfo(`[AIService] ${source}: prompt ${nextPrompt.id} already claimed`);
    return false;
  }

  if (!sendMessageHandler) {
    if (!claimed.claimToken) throw new Error(`Queued prompt ${claimed.id} was claimed without an ownership token`);
    const release = await queueStore.releaseClaim(claimed.id, sessionId, claimed.claimToken);
    if (!settlementAccepted(release)) {
      logError(`[AIService] Failed to release uninitialized-handler claim ${claimed.id} (${release.outcome})`, new Error(release.outcome));
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
